import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import { bashQuote } from './launch.mjs';

export const MAX_FILE_BYTES = 20 * 1024 ** 3;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function remotePath(value) {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || !(value.startsWith('/') || value === '~' || value.startsWith('~/'))) throw fail('请输入远端绝对路径，或 ~/ 开头的路径');
  return value;
}
function name(value) {
  if (typeof value !== 'string' || !value || ['.', '..'].includes(value) || /[\0/]/.test(value) || Buffer.byteLength(value) > 255) throw fail('文件名无效');
  return value;
}
async function jsonBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 16384) throw fail('请求过大', 413); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
export function createFileManager({ scriptPath, getSshArgs, getContext, token, spawnRemote, maxBytes = MAX_FILE_BYTES }) {
  const tickets = new Map(); let active = 0;
  const script = readFile(scriptPath, 'utf8');
  async function run(action, params, { input, signal, onHeader, onData, args } = {}) {
    if (active >= 4) throw fail('文件操作较多，请等当前传输结束后重试', 429);
    active++;
    let child, timer, cancelTimer, abort, uploadStream, inputError;
    try {
      const source = await script;
      if (signal?.aborted) throw fail('操作已取消');
      const encoded = Buffer.from(JSON.stringify(params)).toString('base64');
      const code = `import base64;exec(compile(base64.b64decode('${Buffer.from(source).toString('base64')}'),'<hpc-files>','exec'))`;
      child = spawnRemote ? spawnRemote(action, encoded) : spawn('ssh.exe', ['-T', ...(args || getSshArgs()), `python3 -c ${bashQuote(code)} ${action} ${bashQuote(encoded)}`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', data => { if (stderr.length < 4096) stderr += data.toString('utf8'); });
      const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, sig) => resolve({ code, sig })); });
      // Mark background promises handled even if another leg of the transfer fails first.
      done.catch(() => {});
      let reason;
      abort = () => {
        reason = fail('操作已取消');
        if (input && uploadStream) {
          // EOF lets the remote uploader remove its temporary file before SSH exits.
          input.unpipe(uploadStream); uploadStream.end();
          cancelTimer = setTimeout(() => child.kill(), 3000);
        } else child.kill();
      };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { reason = fail('文件操作超时，请检查连接后重试'); child.kill(); }, input || onData ? 2 * 60 * 60 * 1000 : 35000);
      // Isolate the HTTP request from pipeline's automatic destroy-on-error so
      // an early remote rejection can still return a readable 409 response.
      if (input) {
        uploadStream = new PassThrough();
        inputError = error => uploadStream.destroy(error);
        input.on('error', inputError); input.pipe(uploadStream);
      }
      const incoming = input ? pipeline(uploadStream, child.stdin) : new Promise(resolve => child.stdin.end(resolve));
      incoming.catch(() => {});
      let header = null, pending = Buffer.alloc(0), transferred = 0;
      for await (const chunk of child.stdout) {
        let data = chunk;
        if (!header) {
          pending = Buffer.concat([pending, chunk]);
          const newline = pending.indexOf(10);
          if (newline < 0) { if (pending.length > 8 * 1024 * 1024) throw fail('目录信息过大'); continue; }
          if (newline > 8 * 1024 * 1024) throw fail('目录信息过大');
          header = JSON.parse(pending.subarray(0, newline).toString('utf8'));
          if (!header.ok) throw fail(header.error || '远端文件操作失败', header.code === 'EXISTS' ? 409 : 400);
          if (onHeader) await onHeader(header);
          data = pending.subarray(newline + 1); pending = null;
        }
        if (data.length) {
          if (!onData) throw fail('远端返回了多余数据');
          transferred += data.length;
          if (transferred > header.size || transferred > maxBytes) throw fail('下载大小超出声明范围');
          await onData(data);
        }
      }
      const outcome = await done;
      if (reason) throw reason;
      if (outcome.code !== 0) throw fail(stderr.trim() || '远端文件操作失败，请检查连接或访问权限');
      await incoming;
      if (!header) throw fail(stderr.trim() || '连接中断，未收到文件结果');
      if (onData && transferred !== header.size) throw fail('文件下载未完成，请重试');
      return header.result || header;
    } finally {
      clearTimeout(timer); clearTimeout(cancelTimer); signal?.removeEventListener('abort', abort);
      if (input && uploadStream) { input.unpipe(uploadStream); input.off('error', inputError); uploadStream.destroy(); }
      if (child && child.exitCode === null) child.kill();
      active--;
    }
  }
  const manager = {
    async handle(req, res, url) {
      const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
      const controller = new AbortController();
      const closed = () => { if (!res.writableFinished) controller.abort(); };
      res.once('close', closed);
      try {
        if (req.method === 'GET' && url.pathname.startsWith('/api/files/download/')) {
          const id = url.pathname.slice('/api/files/download/'.length), ticket = tickets.get(id);
          tickets.delete(id);
          if (!ticket || ticket.expires < Date.now()) throw fail('下载链接已过期，请重新点击下载', 410);
          await run('download', { path: ticket.path }, { args: ticket.args, signal: controller.signal,
            onHeader: header => {
              if (!Number.isSafeInteger(header.size) || header.size < 0 || header.size > maxBytes) throw fail('文件大小超过限制');
              const filename = String(header.name).replace(/[\r\n\0]/g, '_');
              res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`, 'Content-Length': String(header.size), 'Cache-Control': 'no-store' });
            },
            onData: async chunk => { if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal }); },
          });
          res.end(); return;
        }
        if (req.method !== 'POST' || req.headers['x-board-token'] !== token) throw fail('请刷新文件管理页后重试', 403);
        if (url.pathname === '/api/files/upload') {
          const size = Number(req.headers['x-file-size']);
          if (req.headers['x-file-size'] === undefined || !Number.isSafeInteger(size) || size < 0 || size > maxBytes) throw fail('每个文件最大 20 GiB', 413);
          if (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) !== size) throw fail('上传大小与声明不一致');
          const params = { path: remotePath(url.searchParams.get('path')), name: name(url.searchParams.get('name')), size };
          const result = await run('upload', params, { input: req, signal: controller.signal });
          json(200, result); return;
        }
        const body = await jsonBody(req);
        if (url.pathname === '/api/files/list') {
          json(200, { ...(await run('list', { path: remotePath(body.path || '~'), hidden: body.hidden === true }, { signal: controller.signal })), context: getContext(), maxBytes }); return;
        }
        if (url.pathname === '/api/files/mkdir') {
          json(200, await run('mkdir', { path: remotePath(body.path), name: name(body.name) }, { signal: controller.signal })); return;
        }
        if (url.pathname === '/api/files/download') {
          const path = remotePath(body.path), args = getSshArgs();
          await run('stat', { path }, { args, signal: controller.signal });
          for (const [id, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(id);
          if (tickets.size >= 50) throw fail('等待下载的文件较多，请稍后重试', 429);
          const id = randomBytes(24).toString('hex');
          tickets.set(id, { path, args, expires: Date.now() + 2 * 60 * 1000 });
          json(200, { url: '/api/files/download/' + id }); return;
        }
        throw fail('文件接口不存在', 404);
      } catch (error) {
        if (res.headersSent || res.destroyed) res.destroy();
        else { req.resume(); json(error.status || 400, { error: error.message }); }
      } finally { res.off('close', closed); }
    },
  };
  return manager;
}
