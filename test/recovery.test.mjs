import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery } from '../recovery.mjs';
const project = { id: 'project', path: '/project' };
const original = { pid: 1, procStart: '10', pidDomain: 'node-a', node: { hostname: 'original-node' }, location: { server: 'default', name: 'old', pane: '%1' } };
const duplicate = { pid: 2, procStart: '20', pidDomain: 'node-b', node: { hostname: 'board-node' }, location: { server: 'hpc-claude-board', name: 'new', pane: '%2' } };
function fixture() {
  let active = [original, duplicate];
  const terminated = [];
  const protection = {
    recoveryState: async () => ({ selected: original, active }),
    restartState: async () => ({ active }),
    terminate: async (_, target) => { terminated.push(target); active = active.filter(p => p.pid !== target.pid); },
  };
  return { recovery: createRecovery(protection), terminated, setActive: value => { active = value; } };
}
test('recovery requires explicit consent before stopping duplicates', async () => {
  const { recovery, terminated } = fixture();
  const plan = await recovery.plan(project, 'session', original);
  await assert.rejects(recovery.confirm(plan.planId, false), /确认/);
  assert.deepEqual(terminated, []);
});
test('recovery stops only the listed duplicate and resumes the selected original PID', async () => {
  const { recovery, terminated } = fixture();
  const plan = await recovery.plan(project, 'session', original);
  assert.equal(plan.keep.pid, original.pid);
  assert.deepEqual(plan.stop.map(p => p.pid), [duplicate.pid]);
  const request = await recovery.confirm(plan.planId, true);
  assert.deepEqual(terminated.map(p => p.pid), [duplicate.pid]);
  assert.equal(request.preferredProcess.pid, original.pid);
  await assert.rejects(recovery.confirm(plan.planId, true), /过期/);
});
test('a changed process set invalidates consent without sending any signals', async () => {
  const { recovery, terminated, setActive } = fixture();
  const plan = await recovery.plan(project, 'session', original);
  setActive([original, { ...duplicate, procStart: '999' }]);
  await assert.rejects(recovery.confirm(plan.planId, true), /变化/);
  assert.deepEqual(terminated, []);
});
test('an original with no duplicates can be attached without termination consent', async () => {
  const { recovery, terminated, setActive } = fixture();
  setActive([original]);
  const plan = await recovery.plan(project, 'session', original);
  const request = await recovery.confirm(plan.planId, false);
  assert.equal(request.preferredProcess.pid, original.pid);
  assert.deepEqual(terminated, []);
});
test('restart requires consent and returns the same conversation without pinning the exited PID', async () => {
  const { recovery, terminated, setActive } = fixture();
  setActive([original]);
  const plan = await recovery.planRestart(project, 'same-session-uuid', 'claude');
  await assert.rejects(recovery.confirm(plan.planId, false), /确认/);
  assert.deepEqual(terminated, []);
  const request = await recovery.confirm(plan.planId, true);
  assert.deepEqual(terminated.map(p => p.pid), [original.pid]);
  assert.equal(request.sessionId, 'same-session-uuid');
  assert.equal(request.preferredProcess, undefined);
  assert.equal(request.account, 'claude');
});
