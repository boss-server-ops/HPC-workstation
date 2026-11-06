import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
test('isolated first-run HTTP setup stays offline, enforces origin/token, and saves only recipient settings', {timeout:15000}, async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'hpc-setup-test-'));
  const reserve = http.createServer(); await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
  const port = reserve.address().port; await new Promise(r=>reserve.close(r));
  // An empty PATH means any accidental SSH attempt fails immediately.
  const child = spawn(process.execPath, [path.join(root,'server.mjs')], {env:{...process.env,PATH:'',HPC_BOARD_DATA:data,HPC_BOARD_PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data', d=>output+=d); child.stderr.on('data', d=>output+=d);
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i=0;i<100 && !output.includes(base);i++) await new Promise(r=>setTimeout(r,50));
    assert.ok(output.includes(base), output);
    const state = await (await fetch(base+'/api/state')).json();
    assert.equal(state.setupRequired,true); assert.equal(state.snapshot,null);
    assert.equal(state.connection.host,''); assert.equal(state.config.host,'');
    assert.deepEqual(await readdir(data),[]);
    const send = (route,body,headers={}) => fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Board-Token':state.token,...headers},body:JSON.stringify(body)});
    assert.equal((await send('/api/setup',{}, {'X-Board-Token':'wrong'})).status,403);
    assert.equal((await send('/api/setup',{}, {Origin:'https://example.com'})).status,403);
    assert.equal((await (await send('/api/launch',{})).json()).code,'SETUP_REQUIRED');
    assert.equal((await send('/api/setup',{host:'-bad'})).status,400);
    const saved = await (await send('/api/setup',{host:'my-hpc',nodeAddress:'192.0.2.10',password:'TEST_SECRET',jump:{password:'TEST_SECRET'}})).json();
    assert.equal(saved.setupRequired,false); assert.equal(saved.snapshot,null);
    assert.equal(saved.config.host,'my-hpc'); assert.ok(!JSON.stringify(saved).includes('TEST_SECRET'));
    assert.equal((await (await send('/api/launch',{})).json()).code,'NODE_VERIFICATION_REQUIRED');
    assert.equal((await (await send('/api/refresh',{})).json()).code,'NODE_VERIFICATION_REQUIRED');
    assert.ok(!output.includes('spawn ssh'));
    const disk = await readFile(path.join(data,'config.json'),'utf8');
    assert.ok(!disk.includes('TEST_SECRET')); assert.equal(JSON.parse(disk).nodeAddress,'192.0.2.10');
    for (const asset of ['/', '/app.js', '/vendor/xterm.js', '/files', '/files.js', '/files.css']) assert.equal((await fetch(base+asset)).status,200);
    assert.equal((await (await send('/api/files/list',{path:'~'})).json()).code,'NODE_VERIFICATION_REQUIRED');
  } finally {
    if (child.exitCode===null) { const exited=once(child,'exit'); child.kill(); await exited; }
    assert.equal(path.dirname(path.resolve(data)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(data).startsWith('hpc-setup-test-'));
    await rm(data,{recursive:true,force:true});
  }
});
