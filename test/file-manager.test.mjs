import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { createFileManager } from '../file-manager.mjs';

const python = process.env.HPC_TEST_PYTHON || 'python';
const scriptPath = fileURLToPath(new URL('../remote-files.py', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const wrapper = "import sys,json,base64,os,runpy;m=runpy.run_path(sys.argv[1],run_name='hpc_files');p=json.loads(base64.b64decode(sys.argv[4]));p['path']=os.path.join(sys.argv[2],p['path'].removeprefix('/fixture').lstrip('/'));m['main'](sys.argv[3],p)";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'hpc-file-test-'));
  const manager = createFileManager({ scriptPath, token:'fixture-token', getSshArgs:()=>[], getContext:()=>({node:'fixture',mode:'direct',projects:[]}), maxBytes:8*1024*1024,
    spawnRemote: (action, encoded) => spawn(python, ['-c', wrapper, scriptPath, directory, action, encoded], { windowsHide:true, stdio:['pipe','pipe','pipe'] }),
  });
  const server = http.createServer((req,res)=>manager.handle(req,res,new URL(req.url,'http://fixture')));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const api = async (action, body, authorized=true) => {
    const response = await fetch(origin+'/api/files/'+action,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{'X-Board-Token':'fixture-token'}:{})},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const upload = async (name, bytes) => {
    const response = await fetch(origin+'/api/files/upload?'+new URLSearchParams({path:'/fixture',name}), {method:'POST',headers:{'X-Board-Token':'fixture-token','X-File-Size':String(bytes.length)},body:bytes});
    return {status:response.status,body:await response.json()};
  };
  return {directory,origin,api,upload, async close(){server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}};
}
test('binary upload/download round-trip, Unicode and shell punctuation names, listing, hidden files, folder creation', {timeout:20000}, async()=>{
  const f=await fixture();
  try {
    const name="资料 space ' ;$().bin", bytes=randomBytes(2*1024*1024+37);
    const result=await f.upload(name,bytes);assert.equal(result.status,200);assert.equal(result.body.sha256,digest(bytes));
    assert.equal(digest(await readFile(path.join(f.directory,name))),digest(bytes));
    await writeFile(path.join(f.directory,'.hidden'),'hidden');
    assert.equal((await f.api('mkdir',{path:'/fixture',name:'实验目录'})).status,200);
    const listing=await f.api('list',{path:'/fixture'});assert.equal(listing.status,200);
    assert.ok(listing.body.entries.some(e=>e.name===name&&e.file));assert.ok(listing.body.entries.some(e=>e.name==='实验目录'&&e.directory));assert.ok(!listing.body.entries.some(e=>e.name==='.hidden'));
    assert.ok((await f.api('list',{path:'/fixture',hidden:true})).body.entries.some(e=>e.name==='.hidden'));
    const ticket=await f.api('download',{path:'/fixture/'+name});assert.equal(ticket.status,200);
    const download=await fetch(f.origin+ticket.body.url);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/filename\*=UTF-8/);
    assert.equal(digest(Buffer.from(await download.arrayBuffer())),digest(bytes));
    assert.equal((await fetch(f.origin+ticket.body.url)).status,410);
    assert.equal((await f.api('download',{path:'/fixture/实验目录'})).status,400);
  } finally {await f.close();}
});

test('same-name uploads and path escapes never replace existing data; auth and size checks apply', {timeout:15000}, async()=>{
  const f=await fixture();
  try {
    assert.equal((await f.upload('keep.txt',Buffer.from('original'))).status,200);
    const conflict=await f.upload('keep.txt',Buffer.from('replacement'));assert.equal(conflict.status,409);assert.match(conflict.body.error,/同名文件/);
    assert.equal(await readFile(path.join(f.directory,'keep.txt'),'utf8'),'original');
    assert.equal((await f.upload('../escape',Buffer.from('no'))).status,400);
    assert.equal((await f.api('list',{path:'/fixture'},false)).status,403);
    assert.equal((await f.api('list',{path:'relative/path'})).status,400);
    assert.equal((await f.api('mkdir',{path:'/fixture',name:'../escape'})).status,400);
    const tooBig=await fetch(f.origin+'/api/files/upload?path=/fixture&name=big.bin',{method:'POST',headers:{'X-Board-Token':'fixture-token','X-File-Size':'9000000'},body:''});assert.equal(tooBig.status,413);
    assert.equal((await f.upload('empty',Buffer.alloc(0))).status,200);
    assert.ok(!(await readdir(f.directory)).some(name=>name.startsWith('.hpc-upload-')));
  } finally {await f.close();}
});

test('truncated upload never publishes a partial file and removes its temporary file', {timeout:15000}, async()=>{
  const f=await fixture();
  try {
    const response=await new Promise((resolve,reject)=>{
      const request=http.request(f.origin+'/api/files/upload?path=/fixture&name=partial.bin',{method:'POST',headers:{'X-Board-Token':'fixture-token','X-File-Size':'1000','Transfer-Encoding':'chunked'}},res=>{let data='';res.on('data',b=>data+=b);res.on('end',()=>resolve({status:res.statusCode,data}));});
      request.on('error',reject);request.end('too-short');
    });
    assert.equal(response.status,400);assert.match(response.data,/上传中断/);
    assert.deepEqual(await readdir(f.directory),[]);
  } finally {await f.close();}
});

test('client cancellation closes the upload stream and removes the unfinished temporary file', {timeout:15000}, async()=>{
  const f=await fixture();
  let request;
  try {
    request=http.request(f.origin+'/api/files/upload?path=/fixture&name=cancelled.bin',{method:'POST',headers:{'X-Board-Token':'fixture-token','X-File-Size':'8000000','Transfer-Encoding':'chunked'}});
    request.on('error',()=>{}); request.write(randomBytes(300000));
    let entries=[];
    for(let i=0;i<200;i++){entries=await readdir(f.directory);if(entries.length)break;await new Promise(r=>setTimeout(r,10));}
    assert.ok(entries.some(name=>name.startsWith('.hpc-upload-')),'upload must have started before cancelling');
    request.destroy();
    for(let i=0;i<300;i++){entries=await readdir(f.directory);if(!entries.length)break;await new Promise(r=>setTimeout(r,10));}
    assert.deepEqual(entries,[]);
  } finally {request?.destroy();await f.close();}
});
