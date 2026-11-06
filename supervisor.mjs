import http from 'node:http';
import path from 'node:path';
import { mkdirSync, openSync, closeSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export async function startSupervisor({ root = ROOT, boardPort = 43127, statusPort = 43128, intervalMs = 2000, workerScript = path.join(root, 'server.mjs') } = {}) {
  const data = path.join(root, 'data');
  mkdirSync(data, { recursive: true });
  const log = (event, fields = {}) => appendFileSync(path.join(data, 'supervisor.log'), JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n');
  let child = null, stopped = false, timer, checking = false, restartAt = 0, launches = 0, failures = 0, lastExit = null, health = 'starting';
  const status = () => ({ app: 'hpc-board-supervisor', pid: process.pid, workerPid: child?.pid || null, launches, health, lastExit });
  // This read-only loopback endpoint is also the singleton lock. It exposes no
  // credentials or tokens, and prevents another supervisor from starting workers.
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/status' || req.headers.origin || req.headers.host !== `127.0.0.1:${server.address().port}`) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(status()));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(statusPort, '127.0.0.1', resolve); });
  log('supervisor-start', { pid: process.pid });
  function probe() {
    return new Promise(resolve => {
      const request = http.get({ hostname: '127.0.0.1', port: boardPort, path: '/api/health', timeout: 2000 }, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; if (body.length > 4096) request.destroy(); });
        response.on('end', () => {
          try { const health = JSON.parse(body); resolve(health.app === 'hpc-claude-board' && child && health.pid === child.pid ? 'ready' : 'port-conflict'); }
          catch { resolve('port-conflict'); }
        });
        response.on('error', () => resolve('unresponsive'));
      });
      request.once('timeout', () => request.destroy(Object.assign(new Error('Health timeout'), { code: 'ETIMEDOUT' })));
      request.once('error', error => resolve(error.code === 'ECONNREFUSED' ? 'stopped' : 'unresponsive'));
    });
  }
  function launch() {
    const out = openSync(path.join(data, 'server.log'), 'a'), err = openSync(path.join(data, 'server-error.log'), 'a');
    let next;
    try {
      next = spawn(process.execPath, [workerScript], { cwd: root, windowsHide: true, stdio: ['ignore', out, err], env: { ...process.env, HPC_BOARD_PORT: String(boardPort), HPC_BOARD_DATA: data, HPC_BOARD_SUPERVISED: '1' } });
    } finally { closeSync(out); closeSync(err); }
    child = next; launches++; failures = 0; health = 'starting';
    log('worker-start', { pid: next.pid, launches });
    let finished = false;
    const finish = (code, signal, error) => {
      if (finished) return; finished = true;
      lastExit = { time: new Date().toISOString(), pid: next.pid, code, signal, ...(error ? { error } : {}) };
      log('worker-exit', lastExit);
      if (child === next) child = null;
      health = 'stopped'; restartAt = Date.now() + intervalMs;
    };
    next.once('error', error => finish(null, null, error.code || 'spawn-error'));
    next.once('exit', (code, signal) => finish(code, signal));
  }
  async function tick() {
    if (stopped || checking) return;
    checking = true;
    try {
      const result = await probe();
      if (stopped) return;
      health = result;
      if (result === 'ready') { failures = 0; return; }
      if (result === 'port-conflict') return;
      if (!child) { if (result === 'stopped' && Date.now() >= restartAt) launch(); return; }
      if (++failures >= 8) {
        log('worker-unresponsive', { pid: child.pid, consecutiveChecks: failures });
        // Only terminate our local worker, never a foreign listener, SSH, tmux,
        // or any remote Claude process.
        child.kill(); failures = 0;
      }
    } catch (error) { log('supervisor-error', { code: error.code || 'unknown' }); }
    finally { checking = false; }
  }
  const stop = async () => {
    if (stopped) return;
    stopped = true; clearInterval(timer);
    const owned = child;
    if (owned && owned.exitCode === null && owned.signalCode === null) {
      await new Promise(resolve => { owned.once('exit', resolve); owned.kill(); });
    }
    await new Promise(resolve => server.close(resolve));
    log('supervisor-stop', { pid: process.pid });
  };
  timer = setInterval(tick, intervalMs);
  await tick();
  return { status, stop, statusPort: server.address().port };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startSupervisor({ boardPort: Number(process.env.HPC_BOARD_PORT || 43127), statusPort: Number(process.env.HPC_BOARD_STATUS_PORT || 43128) }).then(supervisor => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void supervisor.stop(); });
  }).catch(error => { console.error(new Date().toISOString(), error.code || error.message); process.exitCode = 1; });
}
