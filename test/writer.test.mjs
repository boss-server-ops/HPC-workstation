import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { attachWebTerminals } from '../web-terminal.mjs';

const until = async predicate => { for (let i=0;i<150;i++) { if (predicate()) return; await new Promise(r=>setTimeout(r,10)); } throw new Error('Timed out'); };
test('webpages share one PTY and writer; route changes replace transport, preserve protection and ignore old exits', {timeout:10000}, async () => {
  const server=http.createServer();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`, tickets=new Map(), clients=[];
  let spawned=0, killed=0, onOutput, onExit;
  const writes=[], sizes=[];
  const terminals=attachWebTerminals(server,{origin,token:'test-token',tickets,cwd:process.cwd(),spawnTerminal:()=>{
    spawned++;
    return {write:s=>writes.push(s),resize:(c,r)=>sizes.push([c,r]),kill:()=>{killed++;},onData:f=>{onOutput=f;},onExit:f=>{onExit=f;}};
  }});
  async function connect(id, reason=null) {
    tickets.set(id,{identity:'same-session',checkedAt:Date.now(),sshArgs:[],readOnlyReason:reason,expires:Date.now()+30000});
    const ws=new WebSocket(origin.replace('http:','ws:')+'/terminal/'+id,['hpc-board','test-token'],{origin});
    clients.push(ws); ws.messages=[]; ws.on('message',raw=>ws.messages.push(JSON.parse(raw)));
    await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
    ws.send(JSON.stringify({type:'resize',cols:100,rows:30}));
    await until(()=>ws.messages.some(m=>m.type==='access'));
    return ws;
  }
  const send=(ws,message)=>ws.send(JSON.stringify(message));
  const lastAccess=ws=>ws.messages.filter(m=>m.type==='access').at(-1);
  try {
    const first=await connect('first'); await until(()=>spawned===1);
    onOutput('HPC connected\r\n' + 'Initial terminal redraw '.repeat(60) + '\r\nShared output');
    await until(()=>first.messages.some(m=>m.type==='ready'));
    const second=await connect('second');
    assert.equal(spawned,1); assert.equal(lastAccess(first).writable,true); assert.equal(lastAccess(second).writable,false);
    await until(()=>second.messages.some(m=>m.type==='snapshot'&&m.data.includes('Shared output')));
    assert.ok(second.messages.some(m=>m.type==='ready'));
    send(second,{type:'input',data:'READER_REJECTED'}); send(second,{type:'resize',cols:150,rows:50});
    send(first,{type:'input',data:'WRITER_ALLOWED'});
    await until(()=>writes.includes('WRITER_ALLOWED'));
    assert.ok(!writes.includes('READER_REJECTED')); assert.ok(!sizes.some(s=>s[0]===150));
    send(second,{type:'take-control'}); await until(()=>lastAccess(second).writable);
    assert.equal(lastAccess(first).writable,false);
    send(first,{type:'input',data:'FORMER_WRITER_REJECTED'}); send(second,{type:'input',data:'NEW_WRITER_ALLOWED'});
    await until(()=>writes.includes('NEW_WRITER_ALLOWED')); assert.ok(!writes.includes('FORMER_WRITER_REJECTED'));
    second.close(); await until(()=>lastAccess(first).writable);
    send(first,{type:'input',data:'WRITER_RECONNECTED'});
    await until(()=>writes.includes('WRITER_RECONNECTED'));
    const third=await connect('third','Existing duplicate on another node');
    await until(()=>lastAccess(first).blocked);
    send(third,{type:'take-control'}); send(third,{type:'input',data:'CONFLICT_REJECTED'});
    await until(()=>lastAccess(third).blocked);
    assert.equal(lastAccess(third).writable,false); assert.ok(!writes.includes('CONFLICT_REJECTED'));
    const previousExit=onExit;
    terminals.reconnectAll();
    await until(()=>clients.every(ws=>ws.readyState===WebSocket.CLOSED));
    assert.equal(killed,1);
    const fourth=await connect('new-route');
    await until(()=>spawned===2);
    assert.equal(lastAccess(fourth).writable,true);
    previousExit({exitCode:0});
    onOutput('HPC connected\r\nNew route output');
    const fifth=await connect('new-route-viewer');
    await until(()=>fifth.messages.some(m=>m.type==='snapshot'&&m.data.includes('New route output')));
    assert.equal(spawned,2); assert.equal(lastAccess(fifth).writable,false);
    send(fifth,{type:'input',data:'NEW_ROUTE_VIEWER_REJECTED'});
    send(fourth,{type:'input',data:'NEW_ROUTE_WRITER_ALLOWED'});
    await until(()=>writes.includes('NEW_ROUTE_WRITER_ALLOWED'));
    assert.ok(!writes.includes('NEW_ROUTE_VIEWER_REJECTED'));
  } finally {
    for (const ws of clients) ws.terminate();
    await until(()=>clients.every(ws=>ws.readyState===WebSocket.CLOSED));
    await new Promise(r=>server.close(r));
  }
});
