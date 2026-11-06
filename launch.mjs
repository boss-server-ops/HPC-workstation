import { createHash } from 'node:crypto';

export const bashQuote = value => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
export const psQuote = value => "'" + String(value).replaceAll("'", "''") + "'";
export const isSessionId = value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value || '');

export function terminalName(project, account, mode, sessionId) {
  if (mode !== 'shell') {
    if (!isSessionId(sessionId)) throw new Error('请选择一条确定的会话');
    return 'cb-s-' + sessionId.toLowerCase().replaceAll('-', '');
  }
  return 'cb-shell-' + createHash('sha256').update(project.path).digest('hex').slice(0, 20);
}

export function launchPayload(project, account, mode, sessionId, profile = { command: 'claude', configDir: '.claude' }) {
  if (account !== 'claude') throw new Error('无效账号');
  if (!['resume', 'new', 'shell'].includes(mode)) throw new Error('请从网页历史会话列表选择，确保启动前能检查会话占用');
  if (mode !== 'shell' && !isSessionId(sessionId)) throw new Error('无效会话 ID');
  if (!project.path.startsWith('/') || /[\r\n\0]/.test(project.path)) throw new Error('无效目录');
  const name = terminalName(project, account, mode, sessionId);
  const command = mode === 'shell' ? '' : 'CLAUDE_CONFIG_DIR=' + (profile.configDir.startsWith('/') ? bashQuote(profile.configDir) : '"$HOME"/' + bashQuote(profile.configDir)) + ' ' + bashQuote(profile.command) + (mode === 'resume' ? ' --resume ' : ' --session-id ') + bashQuote(sessionId);
  const rc = ['source "$HOME/.bashrc"', `cd -- ${bashQuote(project.path)} || exit 1`, `printf '\\nHPC Claude Board | %s\\n\\n' ${bashQuote(project.name)}`, command, command ? 'exit "$?"' : ''].filter(Boolean).join('\n') + '\n';
  return { name, path: project.path, rc, account, sessionId: mode === 'shell' ? null : sessionId.toLowerCase() };
}

export function remoteLaunchCommand(payload) {
  return 'TERM=xterm-256color python3 ~/.local/state/hpc-claude-board/runtime-v3/start.py ' + bashQuote(Buffer.from(JSON.stringify(payload)).toString('base64'));
}
