import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSession, resumeDestination } from '../protection.mjs';
const node = {hostname:'test-node'};
const inventory = active => [{node, info:{active, unknown:[]}}];
test('a process outside the board blocks a second launch', () => {
  assert.throws(() => decideSession(inventory([{pid:1,terminal:null}]), '/project'), error => error.status === 409);
});
test('a managed session retains its original account when another account reconnects', () => {
  const decision = decideSession(inventory([{pid:1,terminal:'legacy-name',account:'claude'}]), '/project');
  assert.equal(decision.reuse.account, 'claude');
  assert.equal(decision.reuse.terminal, 'legacy-name');
  assert.equal(decision.readOnlyReason, null);
});
test('existing duplicates are preserved and exposed read-only', () => {
  const decision = decideSession(inventory([{pid:1,terminal:'managed'}, {pid:2,terminal:null}]), '/project');
  assert.ok(decision.readOnlyReason.includes('2 个运行进程'));
});
test('an unidentifiable process in the project fails closed', () => {
  assert.throws(() => decideSession([{node,info:{active:[],unknown:[{pid:3,cwd:'/project/worktree'}]}}], '/project'), error => error.status === 409);
});
test('an original default tmux session is attached with its existing process identity', () => {
  const original = { pid: 7, procStart: '100', terminal: null, account: 'claude', location: { server: 'default', name: '910', pane: '%10' } };
  const decision = decideSession(inventory([original]), '/project');
  assert.equal(decision.reuse.terminal, '910');
  assert.equal(decision.reuse.location.server, 'default');
  assert.equal(decision.reuse.pid, 7);
  assert.equal(decision.readOnlyReason, null);
});
test('an exited Claude with an existing tmux shell is restarted on the verified owner node', () => {
  const primary = { hostname: 'primary' }, original = { hostname: 'original' };
  const info = { active: [], unknown: [], terminals: ['leftover-shell'], ownerStarting: false };
  const first = { node: primary, info: { ...info, owner: { hostname: 'original', terminal: 'leftover-shell' } } };
  const inventories = [first, { node: original, info }];
  const decision = decideSession(inventories, '/project', { pid: 123, procStart: 'exited' });
  assert.equal(decision.reuse, null);
  assert.equal(resumeDestination(decision, inventories, first, primary), original);
  info.ownerStarting = true;
  assert.throws(() => resumeDestination(decision, inventories, first, primary), /正在启动/);
});
