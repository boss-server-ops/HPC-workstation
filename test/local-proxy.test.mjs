import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { openSocksTunnel, createLocalProxyGateway, proxyPort } from '../local-proxy.mjs';
import { sshArguments } from '../connection.mjs';

async function socksFixture({ reject = false, stall = false, listenPort = 0 } = {}) {
  const peers = new Set(), targets = [];
  const server = net.createServer(socket => {
    peers.add(socket); socket.on('error', () => {}); socket.once('close', () => peers.delete(socket));
    let pending = Buffer.alloc(0), phase = 'method';
    socket.on('data', data => {
      pending = Buffer.concat([pending, data]);
      if (phase === 'method' && pending.length >= 3) {
        assert.deepEqual([...pending.subarray(0, 3)], [5, 1, 0]); pending = pending.subarray(3); phase = 'connect';
        if (stall) return;
        socket.write(Buffer.from([5])); setTimeout(() => socket.write(Buffer.from([0])), 5);
      }
      if (phase === 'connect' && pending.length >= 10) {
        assert.deepEqual([...pending.subarray(0, 4)], [5, 1, 0, 1]);
        targets.push({ host: [...pending.subarray(4, 8)].join('.'), port: pending.readUInt16BE(8) });
        pending = pending.subarray(10); phase = 'relay';
        const response = Buffer.from([5, reject ? 5 : 0, 0, 3, 4, 116, 101, 115, 116, 0, 22]);
        socket.write(response.subarray(0, 3));
        setTimeout(() => socket.write(Buffer.concat([response.subarray(3), ...(reject ? [] : [Buffer.from('SSH-2.0-fixture\r\n')])])), 5);
      }
      if (phase === 'relay' && pending.length) { socket.write(pending); pending = Buffer.alloc(0); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(listenPort, '127.0.0.1', resolve); });
  return { port: server.address().port, targets, async stop() { for (const peer of peers) peer.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

test('SOCKS handshake handles split replies and preserves SSH bytes after domain address', async () => {
  const fixture = await socksFixture(); let socket;
  try {
    socket = await openSocksTunnel('192.0.2.31', fixture.port);
    const banner = once(socket, 'data'); socket.resume();
    assert.equal((await banner)[0].toString(), 'SSH-2.0-fixture\r\n');
    const echo = once(socket, 'data'); socket.write('encrypted-ssh-payload');
    assert.equal((await echo)[0].toString(), 'encrypted-ssh-payload');
    assert.deepEqual(fixture.targets, [{ host: '192.0.2.31', port: 22 }]);
  } finally { socket?.destroy(); await fixture.stop(); }
});

test('unavailable, rejected and stalled proxies fail without direct fallback', async () => {
  for (const options of [{ reject: true }, { stall: true }]) {
    const fixture = await socksFixture(options);
    try { await assert.rejects(openSocksTunnel('192.0.2.31', fixture.port, { timeoutMs: 100 }), /本地校园代理/); }
    finally { await fixture.stop(); }
  }
  const fixture = await socksFixture(); await fixture.stop();
  await assert.rejects(openSocksTunnel('192.0.2.31', fixture.port), /未开启/);
  for (const port of [0, 65536, 1080.5, '1080', NaN]) assert.throws(() => proxyPort(port));
});

test('local relays bind loopback, restrict targets, and recreate after restart without campus login data', async () => {
  const fixture = await socksFixture();
  const gateway = createLocalProxyGateway(['192.0.2.31']); let peer;
  try {
    await gateway.configure(fixture.port);
    assert.equal(gateway.port('198.51.100.1'), undefined);
    await assert.rejects(gateway.check('198.51.100.1'), /未登记/);
    const connect = async () => {
      peer = net.connect(gateway.port('192.0.2.31'), '127.0.0.1'); peer.on('error', () => {});
      const data = await once(peer, 'data');
      assert.equal(data[0].toString(), 'SSH-2.0-fixture\r\n'); peer.destroy();
    };
    await connect(); assert.equal(gateway.state().available, true);
    gateway.disconnect(); assert.equal(gateway.port('192.0.2.31'), undefined);
    await gateway.configure(fixture.port); await connect();
    const cfg = { connectionMode: 'proxy', host: 'hpc', hostKeyAlias: 'real-hpc-key', nodeAddress: '192.0.2.31' };
    const args = sshArguments(cfg, undefined, undefined, gateway);
    assert.ok(args.includes('HostName=127.0.0.1'));
    assert.ok(args.includes('StrictHostKeyChecking=yes'));
    assert.ok(args.includes('HostKeyAlias=real-hpc-key'));
    assert.ok(args.includes('ProxyCommand=none'));
    assert.ok(args.includes('ProxyJump=none'));
    assert.ok(args.includes(String(gateway.port('192.0.2.31'))));
  } finally { peer?.destroy(); gateway.disconnect(); await fixture.stop(); }
});

test('a saved local route recovers when the campus client starts after the board', async () => {
  const old = await socksFixture(); const port = old.port; await old.stop();
  const gateway = createLocalProxyGateway(['192.0.2.31']); let fixture, peer;
  try {
    await gateway.configure(port);
    const relayPort = gateway.port('192.0.2.31'); assert.ok(relayPort);
    await assert.rejects(gateway.check('192.0.2.31'), /未开启/);
    fixture = await socksFixture({ listenPort: port });
    peer = net.connect(relayPort, '127.0.0.1'); peer.on('error', () => {});
    assert.equal((await once(peer, 'data'))[0].toString(), 'SSH-2.0-fixture\r\n');
    assert.equal(gateway.port('192.0.2.31'), relayPort);
    assert.equal(gateway.state().error, null);
  } finally { peer?.destroy(); gateway.disconnect(); await fixture?.stop(); }
});
