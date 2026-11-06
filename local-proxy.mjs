import net from 'node:net';
import { once } from 'node:events';

export function proxyPort(value = 1080) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('SOCKS 端口须为 1–65535 的整数');
  return value;
}

async function readBytes(socket, size) {
  const chunks = []; let length = 0;
  for (;;) {
    // Drain partial packets before waiting. read(size) can repeatedly emit
    // readable while fewer bytes are buffered, starving the handshake timeout.
    const chunk = socket.read();
    if (chunk !== null) {
      const needed = size - length;
      chunks.push(chunk.subarray(0, needed)); length += Math.min(needed, chunk.length);
      if (chunk.length > needed) socket.unshift(chunk.subarray(needed));
      if (length === size) return Buffer.concat(chunks, size);
      continue;
    }
    if (socket.destroyed || socket.readableEnded) throw new Error('代理在握手期间断开');
    await new Promise((resolve, reject) => {
      const clear = () => { socket.off('readable', ready); socket.off('error', fail); socket.off('end', ended); socket.off('close', ended); };
      const ready = () => { clear(); resolve(); };
      const fail = error => { clear(); reject(error); };
      const ended = () => fail(new Error('代理在握手期间断开'));
      socket.once('readable', ready); socket.once('error', fail); socket.once('end', ended); socket.once('close', ended);
    });
  }
}

/** Only a local SOCKS5 endpoint; the destination is a fixed HPC IPv4 SSH port. */
export async function openSocksTunnel(address, port = 1080, { timeoutMs = 8000 } = {}) {
  proxyPort(port);
  if (net.isIP(address) !== 4) throw new Error('代理目标必须是已登记的 HPC IPv4 地址');
  const socket = net.connect({ host: '127.0.0.1', port });
  // Relay users attach their own error handling after this handshake returns.
  socket.on('error', () => {});
  const timer = setTimeout(() => socket.destroy(new Error('本地代理响应超时')), timeoutMs);
  try {
    await once(socket, 'connect');
    socket.write(Buffer.from([5, 1, 0]));
    const method = await readBytes(socket, 2);
    if (method[0] !== 5 || method[1] !== 0) throw new Error('该端口不是免认证 SOCKS5 代理；请使用本地 SOCKS 端口（通常为 1080），不要填 HTTP 端口 1081');
    socket.write(Buffer.from([5, 1, 0, 1, ...address.split('.').map(Number), 0, 22]));
    const reply = await readBytes(socket, 4);
    if (reply[0] !== 5 || reply[2] !== 0) throw new Error('SOCKS5 响应格式不正确');
    if (reply[1] !== 0) throw new Error(`校园代理已响应，但无法访问 ${address}:22（SOCKS 状态 ${reply[1]}），请检查学校连接是否成功`);
    const length = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await readBytes(socket, 1))[0] : 0;
    if (!length) throw new Error('SOCKS5 返回了无效地址');
    await readBytes(socket, length + 2);
    socket.pause();
    return socket;
  } catch (error) {
    socket.destroy();
    const message = error.code === 'ECONNREFUSED'
      ? `本地校园代理 127.0.0.1:${port} 未开启。请先在 HKUST(GZ) Connect 中连接学校，再点重连。`
      : `本地校园代理：${error.message}`;
    throw Object.assign(new Error(message), { code: 'LOCAL_PROXY_UNAVAILABLE' });
  } finally { clearTimeout(timer); }
}

export function createLocalProxyGateway(targets) {
  const allowed = [...new Set(targets)];
  let listeners = new Map(), sockets = new Set(), configuredPort = 1080, error = null, available = null;
  let queue = Promise.resolve();
  const stop = (servers, peers) => { for (const server of servers.values()) server.close(); for (const peer of peers) peer.destroy(); };
  const gateway = {
    state: () => ({ host: '127.0.0.1', port: configuredPort, configured: !!listeners.size, available, error }),
    port: address => listeners.get(address)?.address()?.port,
    disconnect() { stop(listeners, sockets); listeners = new Map(); sockets = new Set(); available = null; },
    async check(address, port = configuredPort) {
      if (!allowed.includes(address)) throw new Error('代理目标未登记');
      try { const socket = await openSocksTunnel(address, port); socket.destroy(); available = true; error = null; }
      catch (failure) { available = false; error = failure.message; throw failure; }
    },
    configure(port = 1080) {
      proxyPort(port);
      const operation = queue.catch(() => {}).then(async () => {
        if (listeners.size && configuredPort === port) return;
        const next = new Map(), peers = new Set();
        try {
          for (const address of allowed) {
            const server = net.createServer(async socket => {
              peers.add(socket); socket.on('error', () => socket.destroy()); socket.once('close', () => peers.delete(socket));
              try {
                const upstream = await openSocksTunnel(address, port);
                if (socket.destroyed) { upstream.destroy(); return; }
                peers.add(upstream); upstream.once('close', () => { peers.delete(upstream); socket.destroy(); });
                upstream.on('error', () => socket.destroy()); socket.once('close', () => upstream.destroy());
                error = null; available = true;
                socket.pipe(upstream).pipe(socket);
              } catch (failure) { error = failure.message; available = false; socket.destroy(); }
            });
            next.set(address, server);
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
          }
        } catch (failure) { stop(next, peers); throw failure; }
        stop(listeners, sockets); listeners = next; sockets = peers; configuredPort = port; error = null; available = null;
      });
      queue = operation; return operation;
    },
  };
  return gateway;
}
