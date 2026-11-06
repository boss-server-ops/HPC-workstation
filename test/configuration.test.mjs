import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { defaultSettings, validateSettings, requireSettings } from '../configuration.mjs';
import { sshArguments, verifyJumpHost } from '../connection.mjs';
import { launchPayload } from '../launch.mjs';
const sample = () => ({ ...defaultSettings(), host: 'my-hpc', nodeAddress: '192.0.2.10' });
test('fresh installs have no remote targets, credentials, or personal node identities', () => {
  const config = defaultSettings();
  assert.equal(config.host, ''); assert.equal(config.nodeAddress, ''); assert.deepEqual(config.nodes, []);
  assert.throws(() => requireSettings(config), {code:'SETUP_REQUIRED'});
  assert.throws(() => requireSettings(sample()), {code:'NODE_VERIFICATION_REQUIRED'});
});
test('setup discards credential fields at every configurable object level', () => {
  const config = validateSettings({...sample(), password:'TEST_SECRET', apiKey:'TEST_SECRET', jump:{password:'TEST_SECRET'}, claude:{token:'TEST_SECRET'}, nodes:[{address:'192.0.2.11', privateKey:'TEST_SECRET'}]});
  assert.ok(!JSON.stringify(config).includes('TEST_SECRET'));
});
test('setup rejects SSH options, command arguments, path traversal, and duplicate identities', () => {
  for (const patch of [{host:'-oProxyCommand=evil'}, {nodeAddress:'node;echo hi'}, {claude:{command:'claude --resume'}}, {claude:{configDir:'../../private'}}, {nodes:[{address:'192.0.2.10'}, {address:'192.0.2.10'}]}]) assert.throws(() => validateSettings({...sample(), ...patch}));
  assert.throws(() => validateSettings({...sample(), connectionMode:'jump'}));
});
test('direct and jump use only recipient targets and preserve strict host verification', () => {
  const direct = sshArguments(sample());
  assert.ok(direct.includes('HostName=192.0.2.10')); assert.ok(direct.includes('StrictHostKeyChecking=yes')); assert.ok(direct.includes('ProxyJump=none'));
  assert.equal(direct.at(-1), 'my-hpc');
  const config = {...sample(), connectionMode:'jump'};
  assert.throws(() => sshArguments(config), {code:'JUMP_LOGIN_REQUIRED'});
  const jump = sshArguments(config, {address:'192.0.2.11',hostKeyAlias:'node-two'}, {port: address => address === '192.0.2.11' ? 12345 : undefined});
  assert.ok(jump.includes('HostName=127.0.0.1')); assert.ok(jump.includes('12345')); assert.ok(jump.includes('HostKeyAlias=node-two'));
});
test('jump fingerprint accepts only the configured key', () => {
  const key = Buffer.from('synthetic test host key');
  const fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  assert.equal(verifyJumpHost(key, fingerprint), true);
  assert.equal(verifyJumpHost(Buffer.from('different'), fingerprint), false);
});

test('SOCKS configuration keeps strict SSH verification and rejects invalid ports', () => {
  const config = validateSettings({...sample(), connectionMode:'proxy', proxyPort:1080});
  assert.throws(() => sshArguments(config), {code:'LOCAL_PROXY_UNAVAILABLE'});
  const args = sshArguments(config, null, null, {port: () => 12345});
  assert.ok(args.includes('HostName=127.0.0.1'));
  assert.ok(args.includes('HostKeyAlias=192.0.2.10'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.throws(() => validateSettings({...config, proxyPort:0}));
});
test('resume quotes recipient paths and explicitly targets one saved session', () => {
  const session = '11111111-2222-4333-8444-555555555555';
  const payload = launchPayload({path:"/home/researcher/project's $(literal)", name:'demo'}, 'claude', 'resume', session, {command:'my-claude',configDir:'profiles/work'});
  assert.ok(payload.rc.includes('CLAUDE_CONFIG_DIR="$HOME"/\'profiles/work\' \'my-claude\' --resume'));
  assert.ok(payload.rc.includes("project'\"'\"'s $(literal)'"));
  assert.equal(payload.sessionId, session);
  assert.ok(!payload.rc.includes('dangerously-skip-permissions'));
});
