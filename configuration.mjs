export const defaultSettings = () => ({
  host: '', nodeAddress: '', hostKeyAlias: '', connectionMode: 'direct', proxyPort: 1080,
  jump: { host: '', port: 22, username: '', fingerprint: '' },
  nodes: [], claude: { command: 'claude', configDir: '.claude' },
});
const address = value => typeof value === 'string' && /^(?!-)[a-zA-Z0-9][a-zA-Z0-9.:-]{0,252}$/.test(value);
const bounded = (value, limit = 256) => typeof value === 'string' && value.length <= limit && !/[\r\n\0]/.test(value);
export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('配置必须是 JSON 对象');
  const config = { ...defaultSettings(), ...input, jump: { ...defaultSettings().jump, ...input.jump }, claude: { ...defaultSettings().claude, ...input.claude } };
  if (!address(config.host)) throw Error('host 请填写本机 SSH 配置中的别名，不能含空格或命令参数');
  if (!address(config.nodeAddress)) throw Error('nodeAddress 请填写固定 HPC 节点的 IP 或域名');
  if (config.hostKeyAlias && !address(config.hostKeyAlias)) throw Error('hostKeyAlias 格式不正确');
  if (!['direct', 'jump', 'proxy'].includes(config.connectionMode)) throw Error('connectionMode 只能是 direct、jump 或 proxy');
  if (!Number.isInteger(config.proxyPort) || config.proxyPort < 1 || config.proxyPort > 65535) throw Error('proxyPort 必须是有效的本地 SOCKS5 端口');
  if (!/^[a-zA-Z0-9_.-]+$/.test(config.claude.command) || config.claude.command.startsWith('-')) throw Error('Claude command 只能是一个命令名或 shell 函数名，不要填写参数');
  const dir = config.claude.configDir;
  if (!bounded(dir, 1024) || !dir || (!dir.startsWith('/') && dir.split('/').some(part => part === '..'))) throw Error('Claude configDir 请填写家目录下的相对路径或远端绝对路径');
  if (config.jump.host || config.connectionMode === 'jump') {
    if (!address(config.jump.host) || !/^[a-zA-Z0-9_.-]+$/.test(config.jump.username) || config.jump.username.startsWith('-')) throw Error('请填写正确的跳板机地址和用户名');
    if (!Number.isInteger(config.jump.port) || config.jump.port < 1 || config.jump.port > 65535) throw Error('跳板机端口无效');
    if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(config.jump.fingerprint)) throw Error('请向管理员确认跳板机 SHA256 主机指纹后填写');
  }
  if (!Array.isArray(config.nodes) || config.nodes.length > 32) throw Error('nodes 应是最多 32 个节点的数组');
  const nodes = config.nodes.map(node => {
    if (!node || !address(node.address)) throw Error('节点 address 无效');
    if (node.hostname && (!bounded(node.hostname) || !address(node.hostname))) throw Error('节点 hostname 无效');
    if (node.machineId && !/^[a-f0-9]{32}$/.test(node.machineId)) throw Error('节点 machineId 应为 32 位十六进制');
    if (node.hostKeyAlias && !address(node.hostKeyAlias)) throw Error('节点 hostKeyAlias 无效');
    return { address: node.address, hostname: node.hostname || '', machineId: node.machineId || '', hostKeyAlias: node.hostKeyAlias || '' };
  });
  if (new Set(nodes.map(node => node.address)).size !== nodes.length) throw Error('节点地址不能重复');
  const verified = nodes.filter(node => node.machineId);
  if (new Set(verified.map(node => node.machineId)).size !== verified.length) throw Error('每台实际节点只能登记一次，请使用固定地址');
  // Allowlist: never persist password/private-key/token fields pasted into JSON.
  return { host: config.host, nodeAddress: config.nodeAddress, hostKeyAlias: config.hostKeyAlias, connectionMode: config.connectionMode, proxyPort: config.proxyPort,
    jump: { host: config.jump.host, port: config.jump.port, username: config.jump.username, fingerprint: config.jump.fingerprint }, nodes,
    claude: { command: config.claude.command, configDir: config.claude.configDir } };
}
export const hasSettings = config => !!config.host && !!config.nodeAddress;
export function requireSettings(config, verified = true) {
  if (!hasSettings(config)) throw Object.assign(Error('请先打开「配置我的服务器」填写你自己的连接信息'), { code: 'SETUP_REQUIRED' });
  if (verified && !config.nodes.some(node => node.address === config.nodeAddress && node.machineId)) throw Object.assign(Error('请在「配置我的服务器」中验证当前节点，之后才能打开会话'), { code: 'NODE_VERIFICATION_REQUIRED' });
}
