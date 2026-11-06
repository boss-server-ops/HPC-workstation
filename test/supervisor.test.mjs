import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { startSupervisor } from '../supervisor.mjs';

const until = async predicate => {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw Error('Timed out');
};
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));
const removeFixture = async root => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('hpc-supervisor-test-'));
  await rm(root, { recursive: true, force: true });
};

test('supervisor survives abrupt worker exit, records the exit and starts exactly one replacement', { timeout: 12000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hpc-supervisor-test-'));
  const reservation = http.createServer(), boardPort = await listen(reservation); await close(reservation);
  const workerScript = path.join(root, 'worker.mjs');
  await writeFile(workerScript, `import http from 'node:http'; http.createServer((req,res)=>{res.end(JSON.stringify({app:'hpc-claude-board',pid:process.pid}));}).listen(Number(process.env.HPC_BOARD_PORT),'127.0.0.1');`);
  let supervisor;
  try {
    supervisor = await startSupervisor({ root, boardPort, statusPort: 0, workerScript, intervalMs: 60 });
    await until(() => supervisor.status().health === 'ready');
    const firstPid = supervisor.status().workerPid;
    assert.ok(firstPid);
    await assert.rejects(startSupervisor({ root, boardPort, statusPort: supervisor.statusPort, workerScript, intervalMs: 60 }), { code: 'EADDRINUSE' });
    process.kill(firstPid);
    await until(() => supervisor.status().health === 'ready' && supervisor.status().workerPid !== firstPid);
    const state = supervisor.status();
    assert.equal(state.launches, 2); assert.equal(state.lastExit.pid, firstPid);
    const health = await (await fetch(`http://127.0.0.1:${boardPort}/api/health`)).json();
    assert.equal(health.pid, state.workerPid);
    const denied = await fetch(`http://127.0.0.1:${supervisor.statusPort}/status`, { headers: { Origin: 'https://example.com' } });
    assert.equal(denied.status, 403);
    const events = (await readFile(path.join(root, 'data/supervisor.log'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(event => event.event === 'worker-start').length, 2);
    assert.equal(events.filter(event => event.event === 'worker-exit').length, 1);
  } finally { await supervisor?.stop(); await removeFixture(root); }
});

test('an occupied port never causes the supervisor to start or kill a foreign service', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hpc-supervisor-test-'));
  const other = http.createServer((req,res) => res.end(JSON.stringify({app:'some-other-service'})));
  const boardPort = await listen(other);
  let supervisor;
  try {
    supervisor = await startSupervisor({ root, boardPort, statusPort: 0, intervalMs: 60 });
    assert.equal(supervisor.status().health, 'port-conflict');
    assert.equal(supervisor.status().launches, 0);
    await supervisor.stop();
    assert.equal((await (await fetch(`http://127.0.0.1:${boardPort}`)).json()).app, 'some-other-service');
  } finally { await supervisor?.stop(); await close(other); await removeFixture(root); }
});
