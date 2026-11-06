import net from 'node:net';
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';

export const verifyJumpHost = (key, fingerprint) => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '') === fingerprint;

export function sshArguments(config, node, gateway, localProxy) {
  const address = node?.address || config.nodeAddress;
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3'];
  if (config.connectionMode === 'proxy') {
    const port = localProxy?.port(address);
    if (!port) throw Object.assign(new Error('校园 SOCKS 通道尚未配置，请检查连接设置'), {code:'LOCAL_PROXY_UNAVAILABLE'});
    args.push('-o', 'HostName=127.0.0.1', '-p', String(port), '-o', 'ProxyJump=none', '-o', 'ProxyCommand=none');
  } else if (config.connectionMode === 'jump') {
    const port = gateway?.port(address);
    if (!port) {
      const error = new Error('校外跳板机尚未登录或已断开，请点击「连接设置」登录。');
      error.code = 'JUMP_LOGIN_REQUIRED';
      throw error;
    }
    args.push('-o', 'HostName=127.0.0.1', '-p', String(port), '-o', 'ProxyJump=none', '-o', 'ProxyCommand=none');
  } else args.push('-o', `HostName=${address}`, '-o', 'ProxyJump=none', '-o', 'ProxyCommand=none');
  args.push('-o', `HostKeyAlias=${node?.hostKeyAlias || config.hostKeyAlias || address}`, config.host);
  return args;
}

export function createJumpGateway(targets, jump, { makeClient = () => new ssh2.Client(), hostVerifier = key => verifyJumpHost(key, jump.fingerprint) } = {}) {
  let client = null, ready = false, connecting = false, error = null;
  const listeners = new Map(), sockets = new Set();
  function disconnect() {
    const old = client; client = null; ready = false; connecting = false;
    for (const server of listeners.values()) server.close();
    listeners.clear();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    old?.end();
  }
  return {
    state: () => ({ ready, connecting, error, host: jump.host, username: jump.username }),
    port: address => ready ? listeners.get(address)?.address()?.port : undefined,
    disconnect,
    async connect(password) {
      if (connecting) throw new Error('正在登录跳板机，请稍候。');
      if (typeof password !== 'string' || !password || password.length > 1024) throw new Error('请输入跳板机密码。');
      disconnect(); connecting = true; error = null;
      const next = client = makeClient();
      try {
        await new Promise((resolve, reject) => {
          next.once('ready', resolve);
          next.on('error', failure => {
            if (client !== next) return;
            error = failure.level === 'client-authentication' ? '跳板机认证失败，请检查密码。' : '跳板机连接失败：' + failure.message;
            reject(new Error(error));
          });
          next.once('close', () => {
            if (client !== next) return;
            error ||= '跳板机连接已断开，请重新登录。';
            disconnect(); reject(new Error(error));
          });
          next.connect({ host: jump.host, username: jump.username, port: jump.port || 22, password, hostVerifier, readyTimeout: 20000, keepaliveInterval: 20000, keepaliveCountMax: 3 });
        });
        password = undefined;
        // ssh2 no longer needs the password after authentication; do not retain
        // it for reconnect. A new login is required when this gateway closes.
        if (next.config) next.config.password = undefined;
        for (const address of targets) {
          if (client !== next) throw new Error('跳板机已断开，请重新登录。');
          const server = net.createServer(socket => {
            sockets.add(socket); socket.once('close', () => sockets.delete(socket));
            socket.on('error', () => socket.destroy());
            next.forwardOut('127.0.0.1', socket.remotePort || 0, address, 22, (failure, stream) => {
              if (failure || socket.destroyed) { stream?.destroy(); socket.destroy(); return; }
              stream.on('error', () => socket.destroy()); stream.once('close', () => socket.destroy());
              socket.once('close', () => stream.destroy()); socket.pipe(stream).pipe(socket);
            });
          });
          listeners.set(address, server);
          await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        }
        if (client !== next) throw new Error('跳板机已断开，请重新登录。');
        ready = true; connecting = false;
      } catch (failure) {
        password = undefined;
        if (next.config) next.config.password = undefined;
        if (client === next) { error = failure.message; disconnect(); }
        throw failure;
      }
    },
  };
}
