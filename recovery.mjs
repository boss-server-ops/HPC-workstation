import { randomBytes } from 'node:crypto';
import { conflict, referenceKey } from './protection.mjs';

const identity = p => ({ pid: p.pid, procStart: p.procStart, pidDomain: p.pidDomain });
const describe = p => ({ ...identity(p), hostname: p.node.hostname, account: p.account, location: p.location });
const sameProcesses = (a, b) => a.map(referenceKey).sort().join('\n') === b.map(referenceKey).sort().join('\n');

// A plan is kept on the server; the browser can confirm it but cannot substitute
// a different PID or turn a stale confirmation into permission to kill a new PID.
export function createRecovery(protection) {
  const plans = new Map(), busy = new Set();
  return {
    isBusy: sessionId => busy.has(sessionId),
    async planRestart(project, sessionId, account) {
      if (busy.has(sessionId)) throw conflict('该会话正在恢复，请稍后重试。');
      const { active } = await protection.restartState(sessionId, project.path);
      const planId = randomBytes(24).toString('hex'), expires = Date.now() + 120000;
      for (const [id, plan] of plans) if (plan.expires < Date.now()) plans.delete(id);
      plans.set(planId, { kind: 'restart', projectId: project.id, projectPath: project.path, sessionId, stop: active.map(identity), account: active[0]?.account || account, expires });
      return { kind: 'restart', planId, expires, sessionId, stop: active.map(describe) };
    },
    async plan(project, sessionId, selected) {
      if (busy.has(sessionId)) throw conflict('该会话正在恢复，请稍后重试。');
      const state = await protection.recoveryState(sessionId, project.path, selected);
      const stop = state.active.filter(p => referenceKey(p) !== referenceKey(state.selected));
      for (const [id, plan] of plans) if (plan.expires < Date.now()) plans.delete(id);
      const planId = randomBytes(24).toString('hex');
      const expires = Date.now() + 120000;
      plans.set(planId, { projectId: project.id, projectPath: project.path, sessionId, selected: identity(state.selected), stop: stop.map(identity), expires });
      return { planId, expires, keep: describe(state.selected), stop: stop.map(describe) };
    },
    async confirm(planId, consent) {
      const plan = plans.get(planId);
      if (!plan || plan.expires < Date.now()) throw conflict('确认已过期，请重新选择旧会话。');
      if (plan.stop.length && consent !== true) throw conflict('请先确认要结束的重复 Claude 实例。');
      if (busy.has(plan.sessionId)) throw conflict('该会话正在恢复，请稍后重试。');
      plans.delete(planId); busy.add(plan.sessionId);
      try {
        if (plan.kind === 'restart') {
          const live = await protection.restartState(plan.sessionId, plan.projectPath);
          if (!sameProcesses(live.active, plan.stop)) throw conflict('当前进程已变化，请重新检查后重启。');
          for (const target of plan.stop) await protection.terminate(plan.sessionId, target);
          const after = await protection.restartState(plan.sessionId, plan.projectPath);
          if (after.active.length) throw conflict('旧 Claude 尚未退出，未启动新的进程。');
          return { projectId: plan.projectId, sessionId: plan.sessionId, mode: 'resume', account: plan.account };
        }
        const remaining = [plan.selected, ...plan.stop];
        for (const target of plan.stop) {
          const live = await protection.recoveryState(plan.sessionId, plan.projectPath, plan.selected);
          if (!sameProcesses(live.active, remaining)) throw conflict('运行进程已变化，未继续结束进程。请重新检查并确认。');
          await protection.terminate(plan.sessionId, target);
          remaining.splice(remaining.findIndex(p => referenceKey(p) === referenceKey(target)), 1);
        }
        const live = await protection.recoveryState(plan.sessionId, plan.projectPath, plan.selected);
        if (!sameProcesses(live.active, [plan.selected])) throw conflict('仍有重复或未核实的进程，请重新检查；当前保持只读。');
        return { projectId: plan.projectId, sessionId: plan.sessionId, mode: 'resume', preferredProcess: plan.selected };
      } finally { busy.delete(plan.sessionId); }
    },
  };
}
