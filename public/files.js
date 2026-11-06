(() => {
'use strict';
const $ = selector => document.querySelector(selector);
let token = '', current = null, loading = false, browseRequest, sequence = 0, toastTimer, runningUpload = false;
const selected = new Set(), uploads = [];
const readableSize = size => { if (size < 1024) return size + ' B'; const unit = Math.min(4, Math.floor(Math.log(size) / Math.log(1024))); return (size / 1024 ** unit).toFixed(unit > 1 ? 2 : 1) + ' ' + ['B','KiB','MiB','GiB','TiB'][unit]; };
const message = (text, error = false) => { $('#notice').hidden = !error; $('#notice').textContent = error ? text : ''; clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => $('#toast').hidden = true, error ? 8000 : 3500); };
async function bootstrap() {
 const response = await fetch('/api/state');
 if (!response.ok) throw Error('看板服务暂不可用，请返回工作看板检查连接');
 const state = await response.json(); token = state.token;
 const mode = { proxy: '校园代理', jump: '校外跳板机', direct: '校内 / VPN' }[state.config.connectionMode];
 $('#connectionLabel').textContent = (mode || 'HPC') + ' · ' + (state.config.nodeAddress || 'HPC');
 return state;
}
async function api(action, body, signal) {
 if (!token) await bootstrap();
 let response;
 for (let attempt = 0; attempt < 2; attempt++) {
  response = await fetch('/api/files/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Token': token }, body: JSON.stringify(body), signal });
  if (response.status !== 403 || attempt) break;
  await bootstrap();
 }
 const result = await response.json();
 if (!response.ok) throw Error(result.error || '文件操作失败');
 return result;
}
function controls() {
 for (const id of ['chooseUpload','newFolder','copyDirectory','parentDirectory']) $('#' + id).disabled = !current || loading;
 $('#copySelection').disabled = !selected.size || loading;
 $('#selectAll').disabled = loading || !current;
}
async function browse(path = '~') {
 const version = ++sequence;
 browseRequest?.abort(); browseRequest = new AbortController(); loading = true; controls();
 $('#notice').hidden = true; $('#directoryStatus').textContent = '正在读取目录…';
 try {
  const next = await api('list', { path, hidden: $('#showHidden').checked }, browseRequest.signal);
  if (version !== sequence) return;
  current = next; selected.clear(); $('#pathInput').value = current.path;
  $('#dropDestination').textContent = '上传到：' + current.path;
  const url = new URL(location.href); url.searchParams.set('path', current.path); history.replaceState(null, '', url);
  const mode = { proxy: '校园代理', jump: '校外跳板机', direct: '校内 / VPN' }[current.context.mode];
  $('#connectionLabel').textContent = mode + ' · ' + current.context.node;
  renderBreadcrumbs(); renderProjects(); render();
 } catch (error) {
  if (version !== sequence || error.name === 'AbortError') return;
  message(error.message, true); $('#directoryStatus').textContent = current ? '读取失败，仍显示上一目录：' + current.path : '未能读取目录，请检查看板连接后刷新';
 } finally { if (version === sequence) { loading = false; controls(); } }
}
function button(text, className, action, label) {
 const node = document.createElement('button'); node.type = 'button'; node.className = className; node.textContent = text; node.onclick = action; if (label) node.setAttribute('aria-label', label); return node;
}
function renderBreadcrumbs() {
 const nav = $('#breadcrumbs'); nav.replaceChildren(button('/', '', () => browse('/'), '进入根目录'));
 let path = '';
 for (const part of current.path.split('/').filter(Boolean)) {
  path += '/' + part; const target = path;
  const slash = document.createElement('span'); slash.className = 'crumb-separator'; slash.textContent = '/';
  nav.append(slash, button(part, '', () => browse(target)));
 }
}
function renderProjects() {
 const nav = $('#projectShortcuts'); nav.replaceChildren();
 const seen = new Set();
 for (const project of current.context.projects) {
  if (seen.has(project.path)) continue; seen.add(project.path);
  const b = button(project.name, current.path === project.path ? 'active' : '', () => { $('#fileSearch').value = ''; browse(project.path); });
  b.title = project.path; nav.append(b);
 }
}
function visibleEntries() {
 const query = $('#fileSearch').value.toLocaleLowerCase(), sort = $('#fileSort').value;
 return (current?.entries || []).filter(entry => entry.name.toLocaleLowerCase().includes(query)).slice().sort((a,b) => Number(b.directory) - Number(a.directory) || (sort === 'modified' ? b.modified - a.modified : sort === 'size' ? b.size - a.size : 0) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
}
function render() {
 const rows = $('#fileRows'); rows.replaceChildren(); const entries = visibleEntries();
 for (const entry of entries) {
  const row = document.createElement('tr'); row.classList.toggle('selected', selected.has(entry.path));
  const selectCell = document.createElement('td'); selectCell.className = 'select-col';
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(entry.path); checkbox.setAttribute('aria-label', '选择 ' + entry.name);
  checkbox.onchange = () => { checkbox.checked ? selected.add(entry.path) : selected.delete(entry.path); row.classList.toggle('selected', checkbox.checked); selectionState(); };
  selectCell.append(checkbox);
  const nameCell = document.createElement('td'), nameBox = document.createElement('div'); nameBox.className = 'file-name';
  const icon = document.createElement('span'); icon.className = 'file-icon' + (entry.directory ? ' directory' : ''); icon.textContent = entry.directory ? '▱' : '▤'; icon.setAttribute('aria-hidden','true'); nameBox.append(icon);
  if (entry.directory) nameBox.append(button(entry.name, '', () => { $('#fileSearch').value = ''; browse(entry.path); }, '打开目录 ' + entry.name));
  else { const name = document.createElement('span'); name.className = 'name'; name.textContent = entry.name; nameBox.append(name); }
  if (entry.symlink) { const badge = document.createElement('small'); badge.className = 'link-tag'; badge.textContent = '链接'; nameBox.append(badge); }
  nameBox.title = entry.path + '\n' + entry.permissions; nameCell.append(nameBox);
  const size = document.createElement('td'); size.textContent = entry.directory ? '—' : readableSize(entry.size);
  const modified = document.createElement('td'); modified.textContent = new Date(entry.modified * 1000).toLocaleString('zh-CN', { month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit' });
  const actions = document.createElement('td'); actions.append(button('复制路径', 'row-action', () => copy(entry.path), '复制路径 ' + entry.name));
  if (entry.file && !entry.directory) actions.append(button('↓ 下载', 'row-action', event => download(entry, event.currentTarget), '下载 ' + entry.name));
  row.append(selectCell,nameCell,size,modified,actions); rows.append(row);
 }
 $('#emptyDirectory').hidden = !!entries.length;
 $('#emptyDirectory').textContent = $('#fileSearch').value ? '没有匹配的文件，换个关键词试试。' : '这个目录还是空的，上传文件开始使用。';
 $('#directoryStatus').textContent = `${entries.length} 项${entries.length !== current.entries.length ? ' / 共 ' + current.entries.length + ' 项' : ''}${current.skipped ? ' · 部分无权访问的条目已略过' : ''}`;
 selectionState();
}
function selectionState() {
 const entries = visibleEntries();
 $('#selectAll').checked = !!entries.length && entries.every(e => selected.has(e.path));
 $('#selectAll').indeterminate = !$('#selectAll').checked && entries.some(e => selected.has(e.path));
 $('#copySelection').textContent = selected.size ? '复制 ' + selected.size + ' 条路径' : '复制选中路径'; controls();
}
async function copy(text) {
 try { if (!navigator.clipboard?.writeText) throw Error(); await navigator.clipboard.writeText(text); message('远端路径已复制'); }
 catch { $('#copyText').value = text; $('#copyDialog').showModal(); $('#copyText').focus(); $('#copyText').select(); }
}
async function download(entry, control) {
 control.disabled = true;
 try {
  const result = await api('download', { path: entry.path });
  const a = document.createElement('a'); a.href = result.url; a.download = entry.name; document.body.append(a); a.click(); a.remove();
  message('已交给浏览器下载：' + entry.name);
 } catch (error) { message(error.message, true); }
 finally { control.disabled = false; }
}
function enqueue(files) {
 if (!current || loading) { message('请先打开目标目录', true); return; }
 for (const file of files) {
  if (file.size > current.maxBytes) { message(file.name + ' 超过单文件 20 GiB 限制', true); continue; }
  uploads.push({ file, name:file.name, path:current.path, size:file.size, state:'queued', progress:0, detail:'等待上传', xhr:null });
 }
 renderTransfers(); void processUploads();
}
function renderTransfers() {
 $('#transfers').hidden = !uploads.length; $('#transferRows').replaceChildren();
 const complete = uploads.filter(u => u.state === 'done').length;
 $('#transferCount').textContent = complete + ' / ' + uploads.length + ' 完成';
 for (const job of uploads) {
  const row = document.createElement('div'); row.className = 'transfer-row';
  const content = document.createElement('div'), title = document.createElement('div'), path = document.createElement('div'), status = document.createElement('div');
  title.className = 'transfer-name'; title.textContent = job.name + ' · ' + readableSize(job.size);
  path.className = 'transfer-path'; path.textContent = '上传到 ' + job.path;
  status.className = 'transfer-state' + (job.state === 'error' ? ' error' : ''); status.textContent = job.detail;
  const progress = document.createElement('progress'); progress.max = 100; progress.value = job.progress; progress.setAttribute('aria-label', job.name + ' 上传进度');
  content.append(title,path,progress,status); row.append(content);
  if (['queued','uploading'].includes(job.state)) row.append(button('取消', 'text-button', () => {
   if (job.state === 'queued') { job.state = 'cancelled'; job.detail = '已取消'; job.file = null; renderTransfers(); }
   else { job.cancelRequested = true; job.xhr?.abort(); }
  }, '取消上传 ' + job.name));
  if (job.state === 'done') row.append(button('复制路径', 'text-button', () => copy(job.remotePath)));
  $('#transferRows').append(row);
 }
}
function upload(job) {
 return new Promise((resolve,reject) => {
  const xhr = job.xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/files/upload?' + new URLSearchParams({ path:job.path, name:job.name }));
  xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.setRequestHeader('X-Board-Token', token); xhr.setRequestHeader('X-File-Size', String(job.size)); xhr.timeout = 2 * 60 * 60 * 1000;
  xhr.upload.onprogress = e => { job.progress = e.lengthComputable ? e.loaded / e.total * 100 : 0; job.detail = job.progress >= 100 ? '正在等待 HPC 保存确认…' : '正在上传 ' + Math.floor(job.progress) + '%'; renderTransfers(); };
  xhr.onload = () => { try { const result = JSON.parse(xhr.responseText); if (xhr.status !== 200) throw Error(result.error || '上传失败'); resolve(result); } catch (e) { reject(e); } };
  xhr.onerror = () => reject(Error('上传连接中断，请检查网络后重新上传'));
  xhr.ontimeout = () => reject(Error('上传超时，请检查连接'));
  xhr.onabort = () => reject(Object.assign(Error('已取消；若取消时保存已完成，文件可能已存在，请刷新目录确认'), { cancelled:true }));
  xhr.send(job.file);
 });
}
async function processUploads() {
 if (runningUpload) return; runningUpload = true;
 try {
  for (;;) {
   const job = uploads.find(u => u.state === 'queued'); if (!job) break;
   job.state = 'uploading'; job.detail = '正在连接 HPC…'; renderTransfers();
   try {
    await bootstrap();
    if (job.cancelRequested) throw Object.assign(Error('已取消'), { cancelled:true });
    const result = await upload(job); job.remotePath = result.path; job.state = 'done'; job.progress = 100; job.detail = 'HPC 已保存 · ' + readableSize(result.size);
   }
   catch (error) { job.state = error.cancelled ? 'cancelled' : 'error'; job.detail = error.message; }
   finally { job.file = null; job.xhr = null; renderTransfers(); }
   if (!loading && current?.path === job.path) await browse(current.path);
  }
 } finally { runningUpload = false; }
}
$('#pathForm').onsubmit = e => { e.preventDefault(); $('#fileSearch').value = ''; browse($('#pathInput').value); };
$('#parentDirectory').onclick = () => { if (current) { $('#fileSearch').value = ''; browse(current.parent); } };
$('#refreshDirectory').onclick = () => browse(current?.path || $('#pathInput').value || '~');
$('#homeShortcut').onclick = () => { $('#fileSearch').value = ''; browse('~'); };
$('#copyDirectory').onclick = () => current && copy(current.path);
$('#copySelection').onclick = () => copy([...selected].join('\n'));
$('#selectAll').onchange = e => { for (const entry of visibleEntries()) e.target.checked ? selected.add(entry.path) : selected.delete(entry.path); render(); };
$('#fileSearch').oninput = () => current && render(); $('#fileSort').onchange = () => current && render();
$('#showHidden').onchange = () => browse(current?.path || '~');
$('#chooseUpload').onclick = () => $('#uploadInput').click();
$('#uploadInput').onchange = e => { enqueue([...e.target.files]); e.target.value = ''; };
let dragDepth = 0;
const dropPanel = $('.files-panel');
const isFileDrag = e => [...(e.dataTransfer?.types || [])].includes('Files');
const clearDrag = () => { dragDepth = 0; dropPanel.classList.remove('dragover'); };
dropPanel.addEventListener('dragenter', e => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth++; dropPanel.classList.add('dragover'); });
dropPanel.addEventListener('dragover', e => { if (!isFileDrag(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = current && !loading ? 'copy' : 'none'; });
dropPanel.addEventListener('dragleave', e => { if (!isFileDrag(e)) return; if (--dragDepth <= 0) clearDrag(); });
dropPanel.addEventListener('drop', e => {
 e.preventDefault(); clearDrag();
 const items = [...(e.dataTransfer?.items || [])];
 if (items.some(i => i.webkitGetAsEntry?.()?.isDirectory)) { message('文件夹请先压缩成文件再上传', true); return; }
 enqueue([...(e.dataTransfer?.files || [])]);
});
window.addEventListener('dragend', clearDrag);
window.addEventListener('dragover', e => e.preventDefault()); window.addEventListener('drop', e => e.preventDefault());
$('#clearTransfers').onclick = () => { for (let i=uploads.length-1;i>=0;i--) if (!['queued','uploading'].includes(uploads[i].state)) uploads.splice(i,1); renderTransfers(); };
$('#newFolder').onclick = () => { $('#folderParent').textContent = current.path; $('#folderName').value = ''; $('#folderError').textContent = ''; $('#folderDialog').showModal(); $('#folderName').focus(); };
$('#closeFolder').onclick = () => $('#folderDialog').close(); $('#closeCopy').onclick = () => $('#copyDialog').close();
$('#folderForm').onsubmit = async e => { e.preventDefault(); const path = $('#folderParent').textContent; $('#createFolder').disabled = true; try { await api('mkdir', { path, name:$('#folderName').value }); $('#folderDialog').close(); message('文件夹已创建'); if (current?.path === path) await browse(path); } catch(error) { $('#folderError').textContent = error.message; } finally { $('#createFolder').disabled = false; } };
window.addEventListener('beforeunload', e => { if (uploads.some(u => ['queued','uploading'].includes(u.state))) { e.preventDefault(); e.returnValue = ''; } });
controls(); browse(new URL(location.href).searchParams.get('path') || '~');
})();
