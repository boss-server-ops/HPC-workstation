import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import headless from '@xterm/headless';
import serialization from '@xterm/addon-serialize';

// A session has one SSH/PTTY, one writer, and any number of read-only viewers.
export function attachWebTerminals(server, { origin, token, tickets, cwd, spawnTerminal = pty.spawn }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  const hubs = new Map();
  const enqueue = (hub, action) => {
    hub.queue = hub.queue.then(() => hub.ended ? undefined : action()).catch(error => {
      for (const ws of hub.clients) { send(ws, { type: 'error', message: error.message }); ws.close(1011, 'Terminal error'); }
      dispose(hub);
    });
    return hub.queue;
  };
  const send = (ws, message) => { if (ws.readyState === 1) ws.send(JSON.stringify(message)); };
  function access(hub) {
    for (const ws of hub.clients) send(ws, { type: 'access', writable: hub.owner === ws && !hub.readOnlyReason, blocked: !!hub.readOnlyReason, reason: hub.readOnlyReason || (hub.owner ? '另一个网页正在输入；此页面只读。' : '当前无人输入，可点击接管输入。'), viewers: hub.clients.size });
  }
  function output(hub, data) {
    enqueue(hub, () => new Promise(resolve => hub.screen.write(data, () => {
      const startupOutput = hub.tail + data;
      hub.tail = startupOutput.slice(-500);
      if (!hub.ready && startupOutput.includes('HPC connected')) { hub.ready = true; for (const ws of hub.clients) send(ws, { type: 'ready' }); }
      for (const ws of hub.clients) {
        if (ws.boardSyncing) continue;
        if (ws.bufferedAmount > 2 * 1024 * 1024) ws.close(1013, 'Slow connection; reconnect');
        else send(ws, { type: 'output', data });
      }
      resolve();
    })));
  }
  function dispose(hub) {
    if (hub.ended) return;
    hub.ended = true; clearTimeout(hub.cleanup); hubs.delete(hub.identity);
    try { hub.terminal?.kill(); } catch {}
    hub.queue.finally(() => hub.screen.dispose());
  }
  server.on('upgrade', (req, socket, head) => {
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
    const url = new URL(req.url, origin);
    const ticketId = url.pathname.startsWith('/terminal/') ? url.pathname.slice('/terminal/'.length) : '';
    const ticket = tickets.get(ticketId);
    if (req.headers.origin !== origin || req.headers.host !== new URL(origin).host || !protocols.includes(token) || !ticket || ticket.expires < Date.now()) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    tickets.delete(ticketId);
    wss.handleUpgrade(req, socket, head, ws => {
      let hub = hubs.get(ticket.identity);
      if (!hub) {
        const screen = new headless.Terminal({ cols: 100, rows: 30, scrollback: 7000, allowProposedApi: true });
        const serializer = new serialization.SerializeAddon(); screen.loadAddon(serializer);
        hub = { identity: ticket.identity, policyCheckedAt: ticket.checkedAt, sshArgs: ticket.sshArgs, clients: new Set(), owner: null, ready: false, ended: false, tail: '', readOnlyReason: ticket.readOnlyReason || null, screen, serializer, cols: 100, rows: 30, queue: Promise.resolve() };
        screen.onData(data => hub.terminal?.write(data));
        hubs.set(ticket.identity, hub);
      } else if (ticket.checkedAt >= hub.policyCheckedAt) { hub.readOnlyReason = ticket.readOnlyReason || null; hub.policyCheckedAt = ticket.checkedAt; }
      clearTimeout(hub.cleanup); hub.clients.add(ws);
      ws.boardSyncing = true;
      if (!hub.owner && !hub.readOnlyReason) hub.owner = ws;
      let alive = true, initialized = false;
      const heartbeat = setInterval(() => { if (!alive) ws.terminate(); else { alive = false; ws.ping(); } }, 25000);
      const startTimeout = setTimeout(() => { if (!initialized) ws.close(1008, 'Terminal size required'); }, 10000);
      function release() {
        clearInterval(heartbeat); clearTimeout(startTimeout); hub.clients.delete(ws);
        if (hub.owner === ws) hub.owner = hub.readOnlyReason ? null : ([...hub.clients].find(client => client.readyState === 1) || null);
        access(hub);
        if (!hub.clients.size && !hub.ended) hub.cleanup = setTimeout(() => dispose(hub), 1500);
      }
      ws.on('pong', () => { alive = true; });
      ws.on('error', () => ws.terminate());
      ws.once('close', release);
      access(hub);
      enqueue(hub, () => {
        send(ws, { type: 'snapshot', cols: hub.cols, rows: hub.rows, data: hub.serializer.serialize({ scrollback: 1000 }) });
        if (hub.ready) send(ws, { type: 'ready' });
        ws.boardSyncing = false;
      });
      ws.on('message', raw => {
        try {
          const message = JSON.parse(raw.toString());
          const writable = hub.owner === ws && !hub.readOnlyReason;
          if (message.type === 'take-control') {
            if (!hub.readOnlyReason) hub.owner = ws;
            access(hub);
          } else if (message.type === 'resize') {
            const cols = Math.max(20, Math.min(400, Math.floor(Number(message.cols) || 100)));
            const rows = Math.max(8, Math.min(150, Math.floor(Number(message.rows) || 30)));
            initialized = true; clearTimeout(startTimeout);
            enqueue(hub, () => {
            const mayResize = hub.owner === ws && !hub.readOnlyReason;
            if (hub.terminal && (!mayResize || (cols === hub.cols && rows === hub.rows))) return;
            hub.cols = cols; hub.rows = rows; hub.screen.resize(cols, rows);
            for (const client of hub.clients) send(client, { type: 'dimensions', cols, rows });
            if (hub.terminal) hub.terminal.resize(cols, rows);
            else {
              hub.terminal = spawnTerminal('C:\\Windows\\System32\\OpenSSH\\ssh.exe', hub.sshArgs, { name: 'xterm-256color', cols, rows, cwd, env: { ...process.env, TERM: 'xterm-256color' }, useConpty: true, useConptyDll: true });
              hub.terminal.onData(data => output(hub, data));
              hub.terminal.onExit(({ exitCode }) => {
                enqueue(hub, () => {
                hub.ended = true; clearTimeout(hub.cleanup); hubs.delete(hub.identity);
                for (const client of hub.clients) { send(client, { type: 'exit', code: exitCode }); client.close(); }
                hub.screen.dispose();
                });
              });
            }
            });
          } else if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 65536) {
            // The headless screen answers terminal queries once for every viewer.
            const reply = /^\x1b\[[?>]?[0-9;]*[Rcn]$/.test(message.data);
            if (writable && !reply) hub.terminal?.write(message.data);
          }
        } catch (error) { send(ws, { type: 'error', message: error.message }); ws.close(1011, 'Terminal error'); }
      });
    });
  });
  server.on('close', () => { for (const hub of hubs.values()) dispose(hub); for (const ws of wss.clients) ws.terminate(); wss.close(); });
  // A route switch replaces only local SSH transports. Remote tmux/Claude stays
  // alive, and all viewers reconnect through one shared hub with one writer.
  wss.reconnectAll = () => {
    for (const hub of [...hubs.values()]) {
      for (const ws of hub.clients) ws.close(1012, 'Connection route changed');
      dispose(hub);
    }
  };
  return wss;
}
