import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { bashQuote, isSessionId, terminalName, launchPayload, remoteLaunchCommand } from './launch.mjs';
import { attachWebTerminals } from './web-terminal.mjs';
import { createProtection } from './protection.mjs';
import { createRecovery } from './recovery.mjs';
import { createJumpGateway, sshArguments } from './connection.mjs';
import { defaultSettings, validateSettings, hasSettings, requireSettings } from './configuration.mjs';
import { createLocalProxyGateway } from './local-proxy.mjs';
import { createFileManager } from './file-manager.mjs';

const exec = promisify(execFile);
export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.HPC_BOARD_DATA ? path.resolve(process.env.HPC_BOARD_DATA) : path.join(ROOT, 'data');
const PORT = Number(process.env.HPC_BOARD_PORT || 43127);
const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:${PORT}`;
const TOKEN = randomBytes(32).toString('hex');
const defaults = { ...defaultSettings(), account: 'claude', pinned: null, customPaths: [], createdSessions: {} };
let config = { ...defaults }, snapshot = null, refreshInFlight = null, lastError = null;
const tickets = new Map();
const saves = new Map();
let gateway;
let localProxy;
function makeLocalProxy() { return createLocalProxyGateway([...new Set([config.nodeAddress, ...config.nodes.map(node => node.address)].filter(Boolean))]); }
function makeGateway() { return createJumpGateway([...new Set([config.nodeAddress, ...config.nodes.map(node => node.address)].filter(Boolean))], config.jump); }
const sshArgs = node => sshArguments(config, node, gateway, localProxy);
const files = createFileManager({ scriptPath: path.join(ROOT, 'remote-files.py'), getSshArgs: sshArgs, token: TOKEN,
  getContext: () => ({ mode: config.connectionMode, node: config.nodeAddress, projects: projects().map(p => ({id:p.id, name:p.name, path:p.path})) }) });
let protection = createProtection({ root: ROOT, getConfig: () => config, getSshArgs: sshArgs });
let recovery = createRecovery(protection);

async function save(name, value) {
  const content = JSON.stringify(value, null, 2);
  const operation = (saves.get(name) || Promise.resolve()).catch(() => {}).then(async () => {
    const tmp = path.join(DATA, `${name}.tmp`);
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path.join(DATA, name));
  });
  saves.set(name, operation);
  return operation;
}

function projects() {
  const items = [...(snapshot?.projects || [])];
  for (const dir of config.customPaths) {
    if (!items.some(item => item.path === dir)) items.push({ id: createHash('sha256').update(dir).digest('hex').slice(0, 16), path: dir, name: dir.split('/').filter(Boolean).at(-1), command: 'claude', exists: true, sessions: [], updatedAt: 0, custom: true });
  }
  return items;
}

async function refresh() {
  requireSettings(config);
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      await protection.install();
      const script = await readFile(path.join(ROOT, 'remote-index.py'), 'utf8');
      const command = 'python3 -c ' + bashQuote(`import base64;exec(base64.b64decode('${Buffer.from(script).toString('base64')}'))`);
      const { stdout } = await exec('ssh.exe', [...sshArgs(), command], { timeout: 35000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
      const next = JSON.parse(stdout.trim());
      if (!Array.isArray(next.projects) || !next.home) throw new Error('服务器返回的会话索引无效');
      snapshot = next;
      // Keep tmux on the same node even when the HPC login alias load-balances.
      if (!config.nodeAddress && /^\d{1,3}(\.\d{1,3}){3}$/.test(next.nodeAddress)) config.nodeAddress = next.nodeAddress;
      if (config.pinned === null) config.pinned = next.projects.filter(p => p.exists && p.path !== next.home).slice(0, 4).map(p => p.id);
      await save('snapshot.json', snapshot);
      await save('config.json', config);
      lastError = null;
    } catch (error) {
      lastError = '无法刷新 HPC：' + (error.stderr?.trim() || error.message).slice(0, 450);
      throw new Error(lastError);
    } finally {
      refreshInFlight = null;
    }
    return state();
  })();
  return refreshInFlight;
}

function state() {
  return { app: 'hpc-claude-board', token: TOKEN, config, setupRequired: !hasSettings(config), connection: gateway.state(), proxy: localProxy?.state(), snapshot: snapshot ? { ...snapshot, projects: projects() } : null, error: lastError, refreshing: !!refreshInFlight };
}

async function startProcess(executable, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

async function launch(body) {
  requireSettings(config);
  const project = projects().find(p => p.id === body.projectId);
  if (!project) throw new Error('找不到这个项目，请刷新');
  if (!project.exists) throw new Error('远端目录已不存在');
  const mode = body.mode || 'resume';
  if (mode === 'vscode') {
    const script = `& code.cmd --remote 'ssh-remote+${config.host}' '${project.path.replaceAll("'", "''")}'`;
    await startProcess('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
    return { message: '已请求 VS Code 打开远端目录' };
  }
  let account = project.command === 'claude' ? 'claude' : (body.account || config.account);
  if (project.command === 'claude' && body.account && body.account !== 'claude') throw new Error('这个项目使用旧版默认账号的历史记录');
  const sessionId = mode === 'new' ? randomUUID() : (body.sessionId || project.sessions[0]?.id)?.toLowerCase();
  if (mode !== 'shell' && !isSessionId(sessionId)) throw new Error('请选择有效的历史会话，或创建新会话');
  if (mode === 'resume' && !project.sessions.some(s => s.id === sessionId) && config.createdSessions[sessionId]?.path !== project.path) throw new Error('这个项目尚无可恢复的会话，请选择「新会话」');
  let decision;
  if (mode === 'shell') await protection.install();
  else {
    if (recovery.isBusy(sessionId)) throw new Error('该会话正在恢复，请稍后重连。');
    decision = await protection.check(sessionId, project.path, body.preferredProcess);
  }
  if (decision?.reuse) account = decision.reuse.account;
  const actualMode = mode === 'resume' && config.createdSessions[sessionId] && !decision.historyExists && !decision.reuse ? 'new' : mode;
  const payload = launchPayload(project, account, actualMode, sessionId, config.claude);
  const identity = terminalName(project, account, mode, sessionId);
  if (mode === 'new') {
    config.createdSessions[sessionId] = { path: project.path, createdAt: Date.now() };
    await save('config.json', config);
  }
  if (decision?.reuse) { payload.name = decision.reuse.terminal; payload.reuse = true; }
  else if (mode !== 'shell') payload.name += '-' + createHash('sha256').update(decision.generation).digest('hex').slice(0, 10);
  payload.checkedReferences = decision?.checkedReferences || [];
  const base = decision ? protection.sshArgs(decision.node) : sshArgs();
  const existing = decision?.reuse?.location ? { pid: decision.reuse.pid, procStart: decision.reuse.procStart, pidDomain: decision.reuse.pidDomain, readOnly: !!decision.readOnlyReason } : null;
  const command = existing ? `TERM=xterm-256color python3 ~/.local/state/hpc-claude-board/runtime-v3/guard.py ${bashQuote(sessionId)} attach ${bashQuote(Buffer.from(JSON.stringify(existing)).toString('base64'))}` : remoteLaunchCommand(payload);
  const args = ['-tt', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', ...base, command];
  const connectionId = randomBytes(24).toString('hex');
  for (const [id, ticket] of tickets) if (ticket.expires < Date.now()) tickets.delete(id);
  const hubIdentity = `${decision?.node.address || config.nodeAddress}:${decision?.reuse?.location?.server || 'hpc-claude-board'}:${payload.name}`;
  tickets.set(connectionId, { identity: hubIdentity, checkedAt: Date.now(), sshArgs: args, readOnlyReason: decision?.readOnlyReason, expires: Date.now() + 30000 });
  return { connectionId, terminal: identity, connectionKey: hubIdentity, actualTerminal: payload.name, title: project.name, path: project.path, mode: mode === 'shell' ? 'shell' : 'resume', account, sessionId: mode === 'shell' ? undefined : sessionId, readOnlyReason: decision?.readOnlyReason || null, reused: !!decision?.reuse, preferredProcess: existing ? { pid: existing.pid, procStart: existing.procStart, pidDomain: existing.pidDomain } : undefined, replaceConnection: !!body.preferredProcess || (mode !== 'shell' && !decision?.reuse) };
}

async function bodyJson(req) {
  let value = '';
  for await (const chunk of req) {
    value += chunk;
    if (value.length > 32768) throw new Error('请求过大');
  }
  return JSON.parse(value || '{}');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
export const server = http.createServer(async (req, res) => {
  const json = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://${HOST}:${PORT}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
  if (req.headers.host !== `${HOST}:${PORT}`) return json(403, { error: '仅允许本机访问' });
  if (req.headers.origin && req.headers.origin !== ORIGIN) return json(403, { error: '来源不允许' });
  const route = new URL(req.url, ORIGIN).pathname;
  try {
    if (req.method === 'GET' && route === '/api/health') return json(200, { app: 'hpc-claude-board', pid: process.pid, supervised: process.env.HPC_BOARD_SUPERVISED === '1' });
    if (req.method === 'GET' && route === '/api/state') return json(200, state());
    if (route.startsWith('/api/files/')) { requireSettings(config); return await files.handle(req, res, new URL(req.url, ORIGIN)); }
    if (req.method === 'POST' && route.startsWith('/api/')) {
      if (req.headers['x-board-token'] !== TOKEN) return json(403, { error: '请刷新看板后重试' });
      const body = await bodyJson(req);
      if (route === '/api/setup') {
        if (terminals.clients.size || refreshInFlight) throw new Error('请先关闭网页里的终端标签并等待扫描完成，再修改服务器配置；远端会话会保留。');
        const settings = validateSettings(body);
        const changedServer = ['host', 'nodeAddress'].some(key => settings[key] !== config[key]) || JSON.stringify(settings.claude) !== JSON.stringify(config.claude);
        gateway.disconnect(); localProxy?.disconnect(); tickets.clear();
        config = { ...defaults, ...settings, pinned: config.pinned, customPaths: config.customPaths, createdSessions: config.createdSessions };
        if (changedServer) { snapshot = null; config.pinned = null; config.customPaths = []; config.createdSessions = {}; await save('snapshot.json', null); }
        gateway = makeGateway();
        localProxy = makeLocalProxy();
        if (config.connectionMode === 'proxy') await localProxy.configure(config.proxyPort);
        protection = createProtection({ root: ROOT, getConfig: () => config, getSshArgs: sshArgs });
        recovery = createRecovery(protection);
        lastError = null;
        await save('config.json', config);
        return json(200, state());
      }
      if (route === '/api/nodes/verify') {
        requireSettings(config, false);
        const address = body.address || config.nodeAddress;
        const node = config.nodes.find(item => item.address === address);
        if (address !== config.nodeAddress && !node) throw new Error('请先把该节点的 address 加入配置中的 nodes 数组');
        const before = JSON.stringify(config);
        const script = "import json,socket;print(json.dumps(dict(hostname=socket.gethostname(),machineId=open('/etc/machine-id').read().strip())))";
        const { stdout } = await exec('ssh.exe', [...sshArgs(node || { address }), 'python3 -c ' + bashQuote(script)], { timeout: 20000, maxBuffer: 8192, windowsHide: true });
        const identity = JSON.parse(stdout);
        if (!/^[a-f0-9]{32}$/.test(identity.machineId) || !/^[a-zA-Z0-9_.-]+$/.test(identity.hostname)) throw new Error('节点没有返回有效的身份信息');
        if (JSON.stringify(config) !== before) throw new Error('配置在核验期间变化，请重新验证');
        if (node?.machineId && (node.machineId !== identity.machineId || node.hostname !== identity.hostname)) throw new Error('节点身份与之前登记的不一致，请联系管理员核实，不会自动覆盖');
        if (config.nodes.some(item => item.address !== address && item.machineId === identity.machineId)) throw new Error('该实际节点已经登记，请使用已有的固定节点地址');
        config.nodes = config.nodes.filter(item => item.address !== address).concat({ address, hostname: identity.hostname, machineId: identity.machineId, hostKeyAlias: node?.hostKeyAlias || '' });
        await save('config.json', config); lastError = null;
        return json(200, state());
      }
      if (route === '/api/connection/settings') {
        requireSettings(config, false);
        if (!['jump', 'direct', 'proxy'].includes(body.mode)) throw new Error('无效连接方式');
        if (body.mode === 'proxy') {
          if (!/^\d+\.\d+\.\d+\.\d+$/.test(config.nodeAddress)) throw new Error('校园 SOCKS 模式请在配置中使用节点 IPv4 地址');
          await localProxy.check(config.nodeAddress, config.proxyPort);
          await localProxy.configure(config.proxyPort);
        }
        const changed = config.connectionMode !== body.mode;
        config.connectionMode = body.mode; lastError = null;
        await save('config.json', config);
        if (changed) terminals.reconnectAll();
        return json(200, state());
      }
      if (route === '/api/connection/login') {
        requireSettings(config, false);
        if (!config.jump.host || !config.jump.fingerprint) throw new Error('请先配置你的跳板机地址、用户名和主机指纹');
        // Authenticate the outside channel before switching away from a working
        // inside channel. Neither mode selection nor passwords are conflated.
        try { await gateway.connect(body.password); } finally { body.password = undefined; }
        return json(200, state());
      }
      if (route === '/api/refresh') return json(200, await refresh());
      if (route === '/api/launch') return json(200, await launch(body));
      if (route === '/api/session-recovery-confirm') {
        const request = await recovery.confirm(body.planId, body.confirmStop);
        return json(200, { result: await launch(request), request });
      }
      if (route === '/api/session-locations' || route === '/api/session-preview' || route === '/api/session-recovery-plan' || route === '/api/session-restart-plan') {
        requireSettings(config);
        const project = projects().find(p => p.id === body.projectId);
        const sessionId = String(body.sessionId || '').toLowerCase();
        if (!project || !isSessionId(sessionId) || (!project.sessions.some(s => s.id === sessionId) && config.createdSessions[sessionId]?.path !== project.path)) throw new Error('请选择项目中的有效会话');
        if (route === '/api/session-locations') return json(200, await protection.locations(sessionId));
        if (route === '/api/session-restart-plan') return json(200, await recovery.planRestart(project, sessionId, project.command === 'claude' ? 'claude' : config.account));
        if (!body.process || !Number.isSafeInteger(body.process.pid) || body.process.pid <= 0 || typeof body.process.procStart !== 'string' || typeof body.process.pidDomain !== 'string') throw new Error('请选择已核实的运行进程');
        if (route === '/api/session-recovery-plan') return json(200, await recovery.plan(project, sessionId, body.process));
        return json(200, await protection.preview(sessionId, body.process));
      }
      if (route === '/api/settings') {
        if (body.account !== undefined) {
          if (body.account !== 'claude') throw new Error('无效账号');
          config.account = body.account;
        }
        if (body.pinned !== undefined) {
          if (!Array.isArray(body.pinned) || body.pinned.some(id => !projects().some(p => p.id === id))) throw new Error('无效常用项目');
          config.pinned = [...new Set(body.pinned)];
        }
        await save('config.json', config);
        return json(200, state());
      }
      if (route === '/api/project') {
        const dir = String(body.path || '').trim().replace(/\/+$/, '');
        if (!snapshot || !snapshot.directories.includes(dir)) throw new Error('请选择服务器中已发现的目录，然后点击添加');
        if (!config.customPaths.includes(dir)) config.customPaths.push(dir);
        const id = projects().find(p => p.path === dir).id;
        config.pinned = [...new Set([...(config.pinned || []), id])];
        await save('config.json', config);
        return json(200, state());
      }
      return json(404, { error: '接口不存在' });
    }
    const vendor = { '/guide.html': '使用指南.html', '/setup.css': 'public/setup.css', '/vendor/xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js', '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css', '/vendor/addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js' };
    if (req.method === 'GET' && vendor[route]) {
      const content = await readFile(path.join(ROOT, vendor[route]));
      res.writeHead(200, { 'Content-Type': MIME[path.extname(route)], 'Cache-Control': 'public, max-age=3600' });
      return res.end(content);
    }
    if (req.method === 'GET' && ['/', '/files', '/files.js', '/files.css', '/app.js', '/web-terminal.js', '/style.css', '/terminal.css', '/favicon.svg'].includes(route)) {
      const file = route === '/' ? 'index.html' : route === '/files' ? 'files.html' : route.slice(1);
      const content = await readFile(path.join(ROOT, 'public', file));
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-cache' });
      return res.end(content);
    }
    json(404, { error: '页面不存在' });
  } catch (error) { json(error.status || 400, { error: error.message, code: error.code }); }
});

const terminals = attachWebTerminals(server, { origin: ORIGIN, token: TOKEN, tickets, cwd: ROOT });
server.requestTimeout = 2 * 60 * 60 * 1000;
server.on('close', () => { gateway.disconnect(); localProxy?.disconnect(); });

export async function start() {
  await mkdir(DATA, { recursive: true });
  try { config = { ...defaults, ...JSON.parse(await readFile(path.join(DATA, 'config.json'), 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { snapshot = JSON.parse(await readFile(path.join(DATA, 'snapshot.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  config = { ...defaults, ...(hasSettings(config) ? validateSettings(config) : defaultSettings()),
    pinned: Array.isArray(config.pinned) ? config.pinned : null,
    customPaths: Array.isArray(config.customPaths) ? config.customPaths : [],
    createdSessions: config.createdSessions && typeof config.createdSessions === 'object' ? config.createdSessions : {} };
  gateway = makeGateway();
  localProxy = makeLocalProxy();
  if (config.connectionMode === 'proxy') await localProxy.configure(config.proxyPort);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, HOST, resolve); });
  console.log(`HPC Claude Board: ${ORIGIN}`);
  if (!hasSettings(config)) { lastError = '首次使用，请点击「配置我的服务器」。'; return; }
  if (config.connectionMode === 'jump') lastError = '校外模式：请点击「连接设置」登录跳板机。';
  else refresh().catch(error => console.error(error.message));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) start().catch(error => { console.error(error); process.exit(1); });
