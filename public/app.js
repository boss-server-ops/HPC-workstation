const $ = selector => document.querySelector(selector);
let current = null, view = 'all', query = '', toastTimer;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function ago(timestamp) {
  if (!timestamp) return '等待开始';
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
  if (seconds < 30 * 86400) return Math.floor(seconds / 86400) + ' 天前';
  return new Date(timestamp * 1000).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}
function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 9000 : 5000);
}
window.boardToast = toast;
function connectionError(message) {
  if (/banner exchange|Connection timed out|connect ETIMEDOUT/i.test(message || '')) {
    return current?.config.connectionMode === 'jump'
      ? 'SSH 连接 HPC 超时。跳板机登录成功不代表校内通道可用；请检查跳板机到 HPC 的网络，恢复后点击重连。'
      : 'SSH 连接 HPC 超时，请检查校内网络或 VPN，恢复后点击重连。';
  }
  return message;
}
async function api(route, body) {
  const response = await fetch('/api/' + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Token': current?.token || '' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (data.code === 'JUMP_LOGIN_REQUIRED') showConnectionSettings();
    if (['SETUP_REQUIRED', 'NODE_VERIFICATION_REQUIRED'].includes(data.code)) showSetup();
    throw new Error(connectionError(data.error) || '请求失败');
  }
  return data;
}
window.boardApi = api;
window.boardToken = () => current?.token || '';
window.boardReloadState = async () => setState(await api('state'));
function setState(data) { current = data; render(); }
function render() {
  const all = current?.snapshot?.projects || [];
  const pins = current?.config.pinned || [];
  const pinned = all.filter(p => pins.includes(p.id));
  $('#navCount').textContent = all.length;
  $('#pinCount').textContent = pinned.length;
  $('#projectStat').textContent = all.length;
  $('#pinnedStat').textContent = pinned.length;
  $('#sessionStat').textContent = all.reduce((sum, p) => sum + p.sessions.length, 0);
  $('#terminalStat').textContent = current?.snapshot?.terminals.length || 0;
  $('#account').value = current?.config.account || 'claude';
  $('#connectionSettings').textContent = current?.config.connectionMode === 'proxy' ? '校园 · SOCKS' : current?.config.connectionMode === 'jump' ? (current?.connection?.ready ? '校外 · 跳板已登录' : '校外 · 登录') : '校内 · 直连';
  document.querySelectorAll('[data-channel]').forEach(button => {
    const selected = button.dataset.channel === current?.config.connectionMode;
    button.setAttribute('aria-pressed', String(selected));
    button.classList.toggle('active', selected);
  });
  const routeLabel = current?.config.connectionMode === 'proxy' ? '校园 SOCKS 通道' : current?.config.connectionMode === 'jump' ? '校外通道' : '校内 / VPN 通道';
  document.querySelectorAll('[data-channel-status]').forEach(label => {
    label.textContent = current?.error ? `${routeLabel} · 上次连接未成功` : current?.config.connectionMode === 'jump' && !current?.connection?.ready ? '校外通道 · 需要登录' : `已选择${routeLabel}`;
  });
  $('#openPinned').disabled = !pinned.length;
  $('#addProject').disabled = !current?.snapshot;
  $('#sidebarHost').textContent = current?.config.host || '未配置 SSH';
  $('#sidebarNode').textContent = current?.snapshot ? `${current.snapshot.hostname} · ${current.config.nodeAddress || 'SSH'}` : '等待连接';
  const old = current?.snapshot && Date.now() / 1000 - current.snapshot.scannedAt > 600;
  $('.status-dot').classList.toggle('online', !!current?.snapshot && !current?.error && !old);
  $('.status-dot').classList.toggle('offline', !!current?.error || !!old);
  $('#syncTime').textContent = current?.snapshot ? `${ago(current.snapshot.scannedAt)}同步${old ? ' · 缓存' : ''}` : '尚未同步';
  $('#errorBanner').hidden = !current?.error;
  $('#errorBanner').textContent = current?.error ? `${connectionError(current.error)}${current.snapshot ? ' 目前显示上次同步的数据。' : ' 请检查连接设置，再点击刷新。'}` : '';
  let filtered = all.filter(p => view === 'pinned' ? pins.includes(p.id) : view === 'recent' ? p.updatedAt > Date.now() / 1000 - 7 * 86400 : true);
  if (query) filtered = filtered.filter(p => [p.name, p.path, ...p.sessions.map(s => s.title)].join(' ').toLowerCase().includes(query));
  filtered.sort($('#sort').value === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.updatedAt - a.updatedAt);
  const label = { all: '项目总览', pinned: '常用项目', recent: '最近 7 天' }[view];
  $('#breadcrumbView').textContent = label;
  $('#sectionTitle').innerHTML = `${label} <span>${filtered.length}</span>`;
  document.querySelectorAll('[data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === view); button.setAttribute('aria-current', button.dataset.view === view ? 'page' : 'false'); });
  $('#directories').innerHTML = (current?.snapshot?.directories || []).map(dir => `<option value="${esc(dir)}"></option>`).join('');
  if (!all.length) {
    $('#projectGrid').innerHTML = `<div class="empty${current?.refreshing ? ' loading' : ''}">${current?.refreshing ? '正在从 HPC 读取项目和会话…' : current?.error ? '连接后，你的项目会显示在这里。' : '还没有找到历史会话，可以添加一个目录开始。'}</div>`;
    return;
  }
  $('#projectGrid').innerHTML = filtered.length ? filtered.map((p, i) => {
    const latest = p.sessions[0];
    const pinned = pins.includes(p.id);
    return `<article class="project-card" data-project="${p.id}"><div class="card-body"><div class="card-top"><div class="project-icon ${['', 'blue', 'orange', 'purple'][i % 4]}" aria-hidden="true">${['⌘', '⌁', '◇', '⌗'][i % 4]}</div><div class="card-top-right"><span class="time-label">${ago(p.updatedAt)}</span><button class="pin${pinned ? ' pinned' : ''}" data-action="pin" aria-label="${pinned ? '取消常用' : '设为常用'} ${esc(p.name)}" aria-pressed="${pinned}">${pinned ? '★' : '☆'}</button></div></div><h3 title="${esc(p.name)}">${esc(p.name)}</h3><p class="project-path" title="${esc(p.path)}">${esc(p.path)}</p><div class="session-preview"><div class="session-caption">↳ ${latest ? '最近的对话' : '一个新的开始'}</div><p title="${esc(latest?.title || '')}">${esc(latest?.title || '这个目录还没有历史会话，准备好就开始吧。')}</p></div><div class="card-meta"><span>${p.exists ? `${p.sessions.length} 条会话` : '目录不存在'}${p.totalOnDisk > 30 ? ' · 最近 30 条文件' : ''}</span><span class="account-tag">${'Claude'}</span></div></div><div class="card-footer"><button class="button resume-button" data-action="${latest ? 'resume' : 'new'}" ${!p.exists ? 'disabled' : ''}>${latest ? '▷ 继续上次' : '＋ 新会话'}</button><button class="history-button" data-action="history" ${!latest ? 'disabled' : ''}>历史会话</button><div class="card-menu"><button class="menu-button" data-action="menu" aria-label="${esc(p.name)} 的更多操作" aria-expanded="false">⋯</button><div class="dropdown" hidden><button data-action="new">＋ 新会话</button><button data-action="picker">选择会话（终端）</button><button data-action="shell">打开 SSH 终端</button><button data-action="vscode">用 VS Code 打开</button></div></div></div></article>`;
  }).join('') : '<div class="empty">没有符合条件的项目。试试其他关键词，或给项目点亮星标。</div>';
}
async function launchProject(projectId, mode, sessionId, button) {
  if (button) button.disabled = true;
  try {
    const request = { projectId, mode, sessionId };
    const result = await api('launch', request);
    if (result.connectionId) {
      document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
      await window.BoardTerminals.open(result, request);
    } else toast(result.message);
  }
  catch (error) { toast(error.message, true); }
  finally { if (button) button.disabled = false; }
}
function showHistory(project) {
  $('#dialogTitle').textContent = project.name;
  $('#dialogPath').textContent = project.path + ' · 选择一条对话继续';
  $('#sessionList').innerHTML = project.sessions.map(s => `<div class="session-row"><div><p>${esc(s.title)}</p><small>${new Date(s.updatedAt * 1000).toLocaleString('zh-CN')} · ${s.id.slice(0, 8)}</small></div><div class="history-actions"><button class="button secondary" data-location-session="${s.id}" data-project="${project.id}">运行位置</button><button class="button secondary" data-session="${s.id}" data-project="${project.id}">继续 ↗</button></div></div>`).join('');
  $('#sessionDialog').showModal();
}
window.showProjectHistory = projectId => {
  const project = current?.snapshot?.projects.find(p => p.id === projectId);
  if (project) showHistory(project);
};
let locationRequest = null, locatedProcesses = [], previewProcess = null, locationVersion = 0, previewVersion = 0;
window.showSessionLocations = request => {
  locationRequest = { projectId: request.projectId, sessionId: request.sessionId };
  const project = current?.snapshot?.projects.find(p => p.id === request.projectId);
  $('#locationsTitle').textContent = (project?.name || 'Claude') + ' · 找回旧会话';
  $('#locationsIdentity').textContent = '会话 ID：' + request.sessionId;
  if (!$('#locationsDialog').open) $('#locationsDialog').showModal();
  refreshLocations();
};
async function refreshLocations() {
  const version = ++locationVersion;
  previewVersion++; previewProcess = null; locatedProcesses = [];
  $('#locationPreview').hidden = true;
  $('#locationsList').textContent = '';
  $('#locationsNext').textContent = '';
  $('#locationsStatus').textContent = '正在核实各节点的运行进程…';
  $('#refreshLocations').disabled = true;
  try {
    const result = await api('session-locations', locationRequest);
    if (version !== locationVersion) return;
    locatedProcesses = result.processes;
    $('#locationsStatus').textContent = `找到 ${result.processes.length} 个运行进程 · ${new Date(result.checkedAt).toLocaleTimeString('zh-CN')}`;
    $('#locationsList').innerHTML = result.processes.map((p, index) => `<article class="location-card"><div><strong>${esc(p.hostname)} <span>${p.managed ? '看板终端' : '原终端'}</span></strong><p>${esc(p.location ? `tmux ${p.location.name} · ${p.location.attached ? `${p.location.attached} 个窗口已连接` : '当前没有窗口连接'}` : '未找到可接回的 tmux 终端')}</p><small>PID ${p.pid} · ${esc(p.account === 'claude' ? '当前配置' : '外部配置')} · ${esc(p.address)}</small></div><div class="history-actions"><button class="button secondary" data-preview-process="${index}" ${p.location ? '' : 'disabled'}>查看输出</button><button class="button primary" data-recover-process="${index}" ${p.location ? '' : 'disabled'}>接回这个会话</button></div></article>`).join('');
    $('#locationsNext').textContent = result.processes.length > 1 ? '点击「接回这个会话」后，会列出需要结束的重复实例，等你确认再执行。没有确认前，所有进程继续保留。' : result.processes.length ? '点击「接回这个会话」直接进入原来的 Claude，继续提问。没有重复实例时，无需结束任何进程。' : '目前没有找到运行中的进程。可关闭此窗口，从「历史会话」继续对应对话；启动前仍会检查占用。';
  } catch (error) {
    if (version === locationVersion) $('#locationsStatus').textContent = error.message;
  } finally {
    if (version === locationVersion) $('#refreshLocations').disabled = false;
  }
}
async function readLocationPreview(process) {
  const version = ++previewVersion;
  previewProcess = process;
  $('#locationPreview').hidden = false;
  $('#locationPreviewTitle').textContent = `${process.hostname} · tmux ${process.location.name} · PID ${process.pid}`;
  $('#locationOutput').textContent = '正在读取原终端输出…';
  $('#refreshPreview').disabled = true;
  try {
    const result = await api('session-preview', { ...locationRequest, process });
    if (version !== previewVersion) return;
    $('#locationOutput').textContent = result.output || '这个终端暂时没有输出。';
    $('#locationOutput').scrollTop = $('#locationOutput').scrollHeight;
  } catch (error) {
    if (version === previewVersion) $('#locationOutput').textContent = error.message;
  } finally {
    if (version === previewVersion) $('#refreshPreview').disabled = false;
  }
}
$('#locationsList').addEventListener('click', event => {
  const recover = event.target.closest('[data-recover-process]');
  if (recover) { prepareRecovery(locatedProcesses[Number(recover.dataset.recoverProcess)], recover); return; }
  const button = event.target.closest('[data-preview-process]');
  const process = button && locatedProcesses[Number(button.dataset.previewProcess)];
  if (process?.location) readLocationPreview(process);
});
$('#refreshLocations').addEventListener('click', refreshLocations);
$('#refreshPreview').addEventListener('click', () => { if (previewProcess) readLocationPreview(previewProcess); });
let pendingRecovery = null;
function editableSettings() {
  const { host, nodeAddress, hostKeyAlias, connectionMode, proxyPort, jump, nodes, claude } = current.config;
  return { host, nodeAddress, hostKeyAlias, connectionMode, proxyPort, jump, nodes, claude };
}
function showSetup() {
  $('#setupJSON').value = JSON.stringify(editableSettings(), null, 2);
  $('#verifyAddress').value = current.config.nodeAddress || '';
  $('#setupStatus').textContent = '';
  document.querySelectorAll('dialog[open]').forEach(dialog => { if (dialog.id !== 'setupDialog') dialog.close(); });
  if (!$('#setupDialog').open) $('#setupDialog').showModal();
}
document.querySelectorAll('[data-setup]').forEach(button => button.addEventListener('click', showSetup));
$('#saveSetup').addEventListener('click', async () => {
  const button = $('#saveSetup'); button.disabled = true;
  try {
    setState(await api('setup', JSON.parse($('#setupJSON').value)));
    $('#setupJSON').value = JSON.stringify(editableSettings(), null, 2);
    $('#verifyAddress').value = current.config.nodeAddress;
    $('#setupStatus').textContent = '配置已保存。接下来验证节点；校外请先登录跳板机。';
  } catch (error) { $('#setupStatus').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#setupLogin').addEventListener('click', () => { $('#setupDialog').close(); showConnectionSettings('jump'); });
$('#verifySetup').addEventListener('click', async () => {
  const button = $('#verifySetup'); button.disabled = true; $('#setupStatus').textContent = '正在通过 SSH 验证节点…';
  try {
    setState(await api('nodes/verify', {address:$('#verifyAddress').value.trim()}));
    $('#setupJSON').value = JSON.stringify(editableSettings(), null, 2);
    $('#setupStatus').textContent = '节点身份已验证并登记。可以继续登记其他已配置节点，或点击「读取我的项目」。';
  } catch (error) { $('#setupStatus').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#finishSetup').addEventListener('click', async () => {
  const button = $('#finishSetup'); button.disabled = true;
  try { setState(await api('refresh', {})); $('#setupDialog').close(); toast('已读取你自己的项目和会话'); }
  catch (error) { $('#setupStatus').textContent = error.message; }
  finally { button.disabled = false; }
});
function showConnectionSettings(mode) {
  $('#connectionMode').value = typeof mode === 'string' ? mode : current?.config.connectionMode || 'direct';
  $('#jumpPassword').value = '';
  $('#jumpLoginStatus').textContent = current?.connection?.ready ? (current?.error ? '跳板机已登录。' + connectionError(current.error) : '跳板机已登录；HPC 通道会在打开会话时核验。') : current?.connection?.error || '';
  updateConnectionForm();
  if (!$('#connectionDialog').open) $('#connectionDialog').showModal();
}
function updateConnectionForm() {
  const jump = $('#connectionMode').value === 'jump';
  $('#jumpFields').hidden = !jump;
  $('#jumpPassword').required = jump && !current?.connection?.ready;
  $('#connectBoard').textContent = jump ? (current?.connection?.ready ? '使用此连接' : '登录并连接 HPC') : $('#connectionMode').value === 'proxy' ? '使用校园 SOCKS' : '使用校内直连';
}
$('#connectionSettings').addEventListener('click', showConnectionSettings);
$('#terminalConnectionSettings').addEventListener('click', showConnectionSettings);
$('#connectionMode').addEventListener('change', updateConnectionForm);
let switchingChannel = false;
document.querySelectorAll('[data-channel]').forEach(button => button.addEventListener('click', async () => {
  if (switchingChannel) return;
  const mode = button.dataset.channel;
  if (mode === 'jump' && !current?.connection?.ready) { showConnectionSettings('jump'); return; }
  switchingChannel = true;
  document.querySelectorAll('[data-channel]').forEach(item => { item.disabled = true; });
  try {
    setState(await api('connection/settings', { mode }));
    if (!current.config.nodes.some(node => node.address === current.config.nodeAddress && node.machineId)) { showSetup(); return; }
    await window.BoardTerminals.reconnectAll();
    setState(await api('refresh', {}));
    toast(`已切换到${mode === 'proxy' ? '校园 SOCKS' : mode === 'jump' ? '校外跳板机' : '校内 / VPN 直连'}，后台会话继续保留`);
  } catch (error) { toast(error.message, true); }
  finally { switchingChannel = false; document.querySelectorAll('[data-channel]').forEach(item => { item.disabled = false; }); }
}));
$('#connectionForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#connectBoard'); button.disabled = true;
  let password = $('#jumpPassword').value; $('#jumpPassword').value = '';
  $('#jumpLoginStatus').textContent = '正在连接…';
  try {
    const mode = $('#connectionMode').value;
    if (mode === 'jump' && (password || !current.connection?.ready)) {
      setState(await api('connection/login', { password }));
    }
    setState(await api('connection/settings', { mode }));
    if (!current.config.nodes.some(node => node.address === current.config.nodeAddress && node.machineId)) { $('#connectionDialog').close(); showSetup(); $('#setupStatus').textContent = '通道已准备好，请验证并登记节点。'; return; }
    await window.BoardTerminals.reconnectAll();
    setState(await api('refresh', {}));
    password = undefined;
    $('#connectionDialog').close();
    toast(`${mode === 'proxy' ? '校园 SOCKS' : mode === 'jump' ? '校外' : '校内 / VPN'}通道已连接，正在接回会话`);
    await window.BoardTerminals.restore();
  } catch (error) { $('#jumpLoginStatus').textContent = error.message; }
  finally { password = undefined; button.disabled = false; updateConnectionForm(); }
});
window.restartSession = async request => {
  const button = $('#restartTerminal'); button.disabled = true;
  try {
    pendingRecovery = await api('session-restart-plan', { projectId: request.projectId, sessionId: request.sessionId });
    if (!pendingRecovery.stop.length) { await finishRecovery(false); return; }
    $('#recoveryHeading').textContent = '重启 Claude，恢复原对话';
    $('#recoveryExplanation').textContent = '重连会保留运行中的进程。如果 Claude 卡住，需要先结束这个进程，再从已保存的同一份对话恢复。';
    $('#recoveryKeep').textContent = '保留对话历史：' + request.sessionId;
    $('#recoveryStop').textContent = '将结束并重新启动：\n' + pendingRecovery.stop.map(p => `${p.hostname} · PID ${p.pid} · tmux ${p.location?.name || '未识别'}`).join('\n');
    $('#recoveryWarning').textContent = '当前尚未完成的请求会被中断。已保存的对话会保留，尚未发送或写入历史的内容可能丢失。重启前会再次核实旧进程已退出。';
    $('#recoveryConsentText').textContent = '我确认结束上述 Claude，并从原对话记录重新启动。';
    $('#confirmRecovery').textContent = '重启并恢复原对话';
    $('#recoveryConsent').checked = false; $('#confirmRecovery').disabled = true; $('#recoveryStatus').textContent = '';
    $('#recoveryDialog').showModal();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
};
async function prepareRecovery(process, button) {
  if (!process?.location) return;
  button.disabled = true;
  try {
    pendingRecovery = await api('session-recovery-plan', { ...locationRequest, process });
    if (!pendingRecovery.stop.length) { await finishRecovery(false); return; }
    const describe = p => `${p.hostname} · tmux ${p.location?.name || '未识别'} · PID ${p.pid}`;
    $('#recoveryHeading').textContent = '确认接回旧会话';
    $('#recoveryExplanation').textContent = '同一份对话有多个 Claude 进程，需要保留一个才能恢复输入。';
    $('#recoveryWarning').textContent = '结束列出的重复 Claude 可能中断它们尚未完成的请求。已保存的对话历史会保留；选中的旧 Claude 不会重新启动。';
    $('#recoveryConsentText').textContent = '我确认结束上面列出的重复 Claude，继续保留的旧会话。';
    $('#confirmRecovery').textContent = '结束重复实例并进入旧会话';
    $('#recoveryKeep').textContent = '保留并进入：' + describe(pendingRecovery.keep);
    $('#recoveryStop').textContent = '将结束：\n' + pendingRecovery.stop.map(describe).join('\n');
    $('#recoveryConsent').checked = false;
    $('#confirmRecovery').disabled = true;
    $('#recoveryStatus').textContent = '';
    $('#recoveryDialog').showModal();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
}
async function finishRecovery(confirmStop) {
  if (!pendingRecovery) return;
  $('#confirmRecovery').disabled = true;
  $('#recoveryStatus').textContent = '正在重新核实进程并接回旧会话…';
  try {
    const { result, request } = await api('session-recovery-confirm', { planId: pendingRecovery.planId, confirmStop });
    pendingRecovery = null;
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    await window.BoardTerminals.open(result, request);
  } catch (error) {
    $('#recoveryStatus').textContent = error.message + ' 请关闭此窗口后重新检查。';
    toast(error.message, true);
  }
}
$('#recoveryConsent').addEventListener('change', () => { $('#confirmRecovery').disabled = !$('#recoveryConsent').checked; });
$('#confirmRecovery').addEventListener('click', () => { if ($('#recoveryConsent').checked) finishRecovery(true); });
$('#projectGrid').addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const card = button.closest('[data-project]');
  const project = current.snapshot.projects.find(p => p.id === card.dataset.project);
  const action = button.dataset.action;
  if (action === 'menu') {
    const dropdown = button.nextElementSibling;
    const open = dropdown.hidden;
    document.querySelectorAll('.dropdown').forEach(d => { d.hidden = true; d.previousElementSibling.setAttribute('aria-expanded', 'false'); });
    dropdown.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    return;
  }
  if (action === 'pin') {
    button.disabled = true;
    try { const pins = current.config.pinned || []; setState(await api('settings', { pinned: pins.includes(project.id) ? pins.filter(id => id !== project.id) : [...pins, project.id] })); }
    catch (error) { toast(error.message, true); button.disabled = false; }
  } else if (action === 'history' || action === 'picker') showHistory(project);
  else { card.querySelector('.dropdown').hidden = true; await launchProject(project.id, action, undefined, button); }
});
$('#sessionList').addEventListener('click', event => {
  const location = event.target.closest('[data-location-session]');
  if (location) window.showSessionLocations({ projectId: location.dataset.project, sessionId: location.dataset.locationSession });
  const b = event.target.closest('[data-session]'); if (b) launchProject(b.dataset.project, 'resume', b.dataset.session, b);
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $('#' + button.dataset.close).close()));
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { view = button.dataset.view; render(); }));
document.addEventListener('click', event => { if (!event.target.closest('.card-menu')) document.querySelectorAll('.dropdown').forEach(d => { d.hidden = true; d.previousElementSibling.setAttribute('aria-expanded', 'false'); }); });
document.addEventListener('keydown', event => { if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !document.querySelector('dialog[open]')) { event.preventDefault(); $('#search').focus(); } });
$('#search').addEventListener('input', event => { query = event.target.value.toLowerCase().trim(); render(); });
$('#sort').addEventListener('change', render);
$('#account').addEventListener('change', async event => { try { setState(await api('settings', { account: event.target.value })); } catch (error) { toast(error.message, true); render(); } });
async function refresh() {
  $('#refreshButton').disabled = true;
  $('#syncTime').textContent = '正在同步…';
  try { setState(await api('refresh', {})); }
  catch (error) { toast(error.message, true); try { setState(await api('state')); } catch {} }
  finally { $('#refreshButton').disabled = false; }
}
$('#refreshButton').addEventListener('click', refresh);
$('#openPinned').addEventListener('click', async () => {
  const button = $('#openPinned');
  button.disabled = true;
  const pins = current.snapshot.projects.filter(p => current.config.pinned.includes(p.id) && p.exists);
  let opened = 0;
  const failures = [];
  for (const project of pins) {
    try {
      const request = { projectId: project.id, mode: project.sessions.length ? 'resume' : 'new' };
      const result = await api('launch', request);
      await window.BoardTerminals.open(result, request);
      opened++;
    }
    catch (error) { failures.push(`${project.name}：${error.message}`); }
  }
  toast(failures.length ? `已打开 ${opened} 个项目；${failures.join('；')}` : `已在网页中打开 ${opened} 个常用项目，可在顶部切换`, !!failures.length);
  button.disabled = false;
});
$('#addProject').addEventListener('click', () => { $('#directoryInput').value = ''; $('#addDialog').showModal(); });
$('#addForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.target.querySelector('button'); button.disabled = true;
  try { setState(await api('project', { path: $('#directoryInput').value })); $('#addDialog').close(); toast('已添加到常用项目'); }
  catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
(async () => { try {
  setState(await api('state'));
  if (current.setupRequired) { showSetup(); return; }
  if (current.config.connectionMode === 'jump' && !current.connection?.ready) { showConnectionSettings(); return; }
  if (current.refreshing || !current.snapshot) await refresh();
  await window.BoardTerminals.restore();
} catch (error) { toast('无法连接本地服务：' + error.message, true); } })();
