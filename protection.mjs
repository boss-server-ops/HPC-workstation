import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bashQuote, isSessionId } from './launch.mjs';
import { sshArguments } from './connection.mjs';

const exec = promisify(execFile);
// Nodes come only from this installation's verified local configuration.
export const referenceKey = ref => [ref.pidDomain, ref.pid, ref.procStart].join('|');
export function conflict(message) { const error = new Error(message); error.status = 409; return error; }

export function decideSession(inventories, projectPath, preferred) {
  const active = inventories.flatMap(({ info, node }) => info.active.map(p => ({ ...p, node, pidDomain: info.domain })));
  const unknown = inventories.flatMap(({ info, node }) => info.unknown.filter(p => p.cwd === projectPath || p.cwd.startsWith(projectPath + '/')).map(p => ({ ...p, node })));
  if (unknown.length) throw conflict(`无法确认 ${unknown[0].node.hostname} 上 PID ${unknown[0].pid} 的会话归属，已阻止重复启动。`);
  const managed = active.filter(p => p.terminal || p.location);
  const location = p => `${p.node.hostname} / PID ${p.pid}`;
  if (!managed.length && active.length) throw conflict(`这条会话已在其他终端运行（${active.map(location).join('；')}），已阻止重复启动。请先在原终端退出 Claude，再从看板恢复。`);
  if (managed.length) {
    const selected = preferred ? managed.find(p => referenceKey(p) === referenceKey(preferred)) : managed[0];
    if (!selected) throw conflict('选中的旧会话已结束或状态已变化，请重新检查。');
    return { reuse: { ...selected, terminal: selected.location?.name || selected.terminal }, readOnlyReason: active.length > 1 ? `检测到同一会话有 ${active.length} 个运行进程（${active.map(location).join('；')}）。当前只读；点击「找回旧会话」，选择要继续的实例并处理重复进程。` : null };
  }
  return { reuse: null, readOnlyReason: null };
}

export function resumeDestination(decision, inventories, first, primary) {
  if (decision.reuse) return decision.reuse.node;
  if (!first.info.owner) return primary;
  const ownerInventory = inventories.find(x => x.node.hostname === first.info.owner.hostname);
  if (!ownerInventory) throw conflict('无法核实旧会话所在的节点，暂不重新启动。');
  if (ownerInventory.info.ownerStarting) throw conflict('Claude 正在启动，请稍后再连接。');
  // Reclaim the reservation on its own node. A leftover tmux shell is retained
  // for inspection, and a fresh terminal will resume the same saved conversation.
  return ownerInventory.node;
}

export function createProtection({ root, getConfig, getSshArgs }) {
  let installed;
  const nodes = () => getConfig().nodes;
  const sshArgs = node => getSshArgs ? getSshArgs(node) : sshArguments(getConfig(), node);
  async function install() {
    if (installed) return installed;
    installed = (async () => {
      const files = { 'guard.py': await readFile(path.join(root, 'remote-guard.py'), 'utf8'), 'start.py': await readFile(path.join(root, 'remote-start.py'), 'utf8'), 'claude-profile.json': JSON.stringify(getConfig().claude) };
      const installer = "import os,json,sys,tempfile;root=os.path.expanduser('~/.local/state/hpc-claude-board/runtime-v3');os.makedirs(root,mode=0o700,exist_ok=True);assert not os.path.islink(root) and os.stat(root).st_uid==os.getuid();files=json.load(sys.stdin)\nfor name,content in files.items():\n fd,tmp=tempfile.mkstemp(dir=root)\n with os.fdopen(fd,'w') as f: f.write(content)\n os.replace(tmp,os.path.join(root,name))\n";
      const primary = nodes().find(n => n.address === getConfig().nodeAddress) || nodes()[0];
      await new Promise((resolve, reject) => {
        const child = spawn('ssh.exe', [...sshArgs(primary), 'python3 -c ' + bashQuote(`import base64;exec(base64.b64decode('${Buffer.from(installer).toString('base64')}'))`)], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
        let error = '';
        const timeout = setTimeout(() => { child.kill(); reject(new Error('部署会话保护超时，请检查连接设置和网络')); }, 25000);
        child.stderr.on('data', data => { error += data; });
        child.on('error', e => { clearTimeout(timeout); reject(e); });
        child.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('无法部署会话保护：' + error.slice(-600))); });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(files));
      });
    })().catch(error => { installed = null; throw error; });
    return installed;
  }
  async function inspectNode(node, sessionId) {
    const { stdout } = await exec('ssh.exe', [...sshArgs(node), `python3 ~/.local/state/hpc-claude-board/runtime-v3/guard.py ${bashQuote(sessionId)}`], { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true });
    const info = JSON.parse(stdout);
    if (info.machineId !== node.machineId || info.hostname !== node.hostname) throw conflict(`节点 ${node.hostname} 的身份发生变化，暂不启动此会话。`);
    return { node, info };
  }
  async function inspect(sessionId) {
    if (!isSessionId(sessionId)) throw new Error('无效会话 ID');
    await install();
    const primary = nodes().find(n => n.address === getConfig().nodeAddress) || nodes()[0];
    const first = await inspectNode(primary, sessionId);
    const targets = new Map([[primary.address, primary]]);
    for (const ref of first.info.references) {
      const machineId = String(ref.pidDomain || '').split(':')[1];
      const node = nodes().find(n => n.machineId === machineId);
      if (!node) throw conflict(`这条会话有无法核对的跨节点占用记录（PID ${ref.pid}），暂不重复启动。`);
      targets.set(node.address, node);
    }
    if (first.info.owner) {
      const node = nodes().find(n => n.hostname === first.info.owner.hostname);
      if (!node) throw conflict('这条会话的保留节点无法核对，暂不重复启动。');
      targets.set(node.address, node);
    }
    const checks = await Promise.allSettled([...targets.values()].filter(n => n.address !== primary.address).map(n => inspectNode(n, sessionId)));
    const inventories = [first];
    for (let i = 0; i < checks.length; i++) {
      const result = checks[i];
      if (result.status !== 'fulfilled') throw conflict('无法核实其他 HPC 节点上的会话是否仍在运行，已阻止重复启动。请稍后重试。');
      inventories.push(result.value);
    }
    for (const item of inventories) {
      if (item.info.unverified?.length) throw conflict(`无法完整核实 ${item.node.hostname} 上 PID ${item.info.unverified.join(', ')} 的状态，暂不重复启动。`);
    }
    for (const ref of first.info.references) {
      const item = inventories.find(x => x.info.machineId === String(ref.pidDomain).split(':')[1]);
      if (item?.info.domain !== ref.pidDomain) throw conflict('会话来自另一个进程命名空间，暂时无法核实占用，已阻止重复启动。');
    }
    return { inventories, first, primary };
  }
  async function check(sessionId, projectPath, preferred) {
    const { inventories, first, primary } = await inspect(sessionId);
    const decision = decideSession(inventories, projectPath, preferred);
    const owner = first.info.owner;
    return { ...decision, node: resumeDestination(decision, inventories, first, primary), historyExists: first.info.historyExists, generation: owner ? [owner.hostname, owner.terminal, owner.pid, owner.procStart].join('|') : 'initial', checkedReferences: first.info.references.map(referenceKey) };
  }
  async function locations(sessionId) {
    const { inventories } = await inspect(sessionId);
    return {
      checkedAt: Date.now(),
      processes: inventories.flatMap(({ node, info }) => info.active.map(p => ({
        hostname: node.hostname, address: node.address, pidDomain: info.domain,
        pid: p.pid, procStart: p.procStart, account: p.account, location: p.location || null,
        managed: !!p.terminal,
      }))),
    };
  }
  async function preview(sessionId, expected) {
    const { inventories } = await inspect(sessionId);
    const match = inventories.find(({ info }) => info.domain === expected.pidDomain && info.active.some(p => p.pid === expected.pid && p.procStart === expected.procStart));
    if (!match) throw conflict('该进程已结束或状态已变化，请重新检查会话位置。');
    const identity = Buffer.from(JSON.stringify({ pid: expected.pid, procStart: expected.procStart, pidDomain: expected.pidDomain })).toString('base64');
    try {
      const { stdout } = await exec('ssh.exe', [...sshArgs(match.node), `python3 ~/.local/state/hpc-claude-board/runtime-v3/guard.py ${bashQuote(sessionId)} preview ${bashQuote(identity)}`], { timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true });
      return JSON.parse(stdout);
    } catch (error) {
      let message = '无法读取原终端输出，请重新检查会话位置。';
      try { message = JSON.parse(error.stdout).error || message; } catch {}
      throw conflict(message);
    }
  }
  async function recoveryState(sessionId, projectPath, selected) {
    const { inventories } = await inspect(sessionId);
    decideSession(inventories, projectPath, selected);
    const active = inventories.flatMap(({ node, info }) => info.active.map(p => ({ ...p, pidDomain: info.domain, node })));
    const process = active.find(p => referenceKey(p) === referenceKey(selected));
    if (!process) throw conflict('选中的旧进程已退出，请点击重连从历史恢复。');
    return { selected: process, active };
  }
  async function restartState(sessionId, projectPath) {
    const { inventories, first } = await inspect(sessionId);
    decideSession(inventories, projectPath);
    if (!first.info.historyExists) throw conflict('这条会话尚无已保存的历史，暂不能重启恢复。');
    if (inventories.some(item => item.info.ownerStarting)) throw conflict('Claude 正在启动，请稍后重试。');
    const active = inventories.flatMap(({ node, info }) => info.active.map(p => ({ ...p, pidDomain: info.domain, node })));
    if (active.length > 1) throw conflict('检测到重复实例，请先通过「找回旧会话」选择保留的进程。');
    return { active };
  }
  async function terminate(sessionId, expected) {
    const machineId = String(expected.pidDomain).split(':')[1];
    const node = nodes().find(n => n.machineId === machineId);
    if (!node) throw conflict('无法核对待结束进程的节点');
    const identity = Buffer.from(JSON.stringify(expected)).toString('base64');
    try {
      const { stdout } = await exec('ssh.exe', [...sshArgs(node), `python3 ~/.local/state/hpc-claude-board/runtime-v3/guard.py ${bashQuote(sessionId)} terminate ${bashQuote(identity)}`], { timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true });
      return JSON.parse(stdout);
    } catch (error) {
      let message = '未能确认重复进程已退出；没有强制结束，请重新检查。';
      try { message = JSON.parse(error.stdout).error || message; } catch {}
      throw conflict(message);
    }
  }
  return { install, check, locations, preview, recoveryState, restartState, terminate, sshArgs };
}
