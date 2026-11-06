(() => {
  const sessions = new Map();
  const $ = selector => document.querySelector(selector);
  let active = null, pendingRestore = [], clipboardSession = null;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const resumable = request => ({ ...request, preferredProcess: undefined });
  const requestKey = request => `${request.projectId}:${request.sessionId || request.mode}`;
  const persist = () => {
    const requests = new Map([...pendingRestore, ...[...sessions.values()].map(s => s.request)].map(request => [requestKey(request), resumable(request)]));
    sessionStorage.setItem('hpc-open-sessions', JSON.stringify([...requests.values()]));
  };
  function tabs() {
    $('#terminalTabs').innerHTML = [...sessions.values()].map(s => `<button class="terminal-tab${s.name === active ? ' active' : ''}" role="tab" aria-selected="${s.name === active}" data-terminal="${s.name}"><span class="tab-dot ${s.connected ? 'live' : ''}"></span>${escape(s.title)}<small>${s.request.mode === 'shell' ? 'SSH' : 'Claude'}</small></button>`).join('');
    $('#showTerminals').hidden = !sessions.size;
    $('#showTerminals').textContent = `打开的会话 · ${sessions.size}`;
  }
  function fit(session) {
    if (!session || session.pane.hidden || $('#terminalWorkspace').hidden) return;
    if (!session.writable && session.remoteSize) return;
    session.fit.fit();
    if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'resize', cols: session.term.cols, rows: session.term.rows }));
  }
  function status(session, text) {
    session.status = text;
    if (session.name === active) { $('#terminalConnection').textContent = text; $('#terminalConnection').classList.toggle('live', session.connected); }
    tabs();
  }
  function retryConnection(session) {
    if (session.closed || session.normalExit || session.retries >= 3) return;
    clearTimeout(session.retryTimer);
    session.retries++;
    status(session, `连接中断 · 正在重连 ${session.retries}/3`);
    session.retryTimer = setTimeout(() => reconnect(session, false), 2000 * session.retries);
  }
  function showAccess(session) {
    session.term.options.disableStdin = !session.writable;
    session.pane.classList.toggle('readonly', !session.writable);
    if (session.name !== active) return;
    $('#inputAccess').textContent = session.writable ? '可输入' : '只读';
    $('#inputAccess').classList.toggle('writable', !!session.writable);
    $('#takeControl').hidden = !!session.writable || !!session.blocked || !session.connected;
    $('#protectionNotice').hidden = !!session.writable || !session.accessReason;
    $('#protectionNotice').textContent = session.accessReason || '';
    $('#sessionLocations').hidden = !session.request.sessionId;
    $('#terminalHistory').hidden = session.request.mode === 'shell';
    $('#restartTerminal').hidden = !session.request.sessionId;
    $('#pasteTerminal').disabled = !session.writable || !session.connected;
    $('#pasteTerminal').title = session.writable && session.connected ? '打开文本框，用 Ctrl+V 粘贴文字' : '粘贴需要已连接并具有输入权；只读时先接管输入';
  }
  function canPaste(session) {
    return session && !session.closed && session.connected && session.writable && session.socket?.readyState === WebSocket.OPEN;
  }
  function validInput(data) {
    return data.length <= 65536 && new TextEncoder().encode(JSON.stringify({ type: 'input', data })).length <= 128 * 1024;
  }
  function clipboardDialog(session, text, copying = false) {
    clipboardSession = { session, socket: session.socket, copying };
    $('#clipboardTitle').textContent = copying ? '复制选中文字' : `粘贴到 ${session.title}`;
    $('#clipboardHelp').textContent = copying ? '浏览器未允许直接复制。文字已选中，请按 Ctrl+C 复制。' : '在下方按 Ctrl+V 粘贴文字，再点击「插入终端」。插入时不会额外按回车。';
    $('#clipboardText').value = text;
    $('#clipboardText').readOnly = copying;
    $('#insertClipboard').hidden = copying;
    $('#clipboardStatus').textContent = '';
    $('#clipboardDialog').showModal();
    $('#clipboardText').focus();
    if (copying) $('#clipboardText').select();
  }
  async function copySelection(session) {
    const text = session?.term.getSelection();
    if (!text) { window.boardToast?.('请按住 Shift，用鼠标拖选要复制的文字。'); return; }
    try {
      await navigator.clipboard.writeText(text);
      window.boardToast?.('已复制选中文字');
    } catch {
      if (!session.closed) clipboardDialog(session, text, true);
    }
  }
  function select(name) {
    const session = sessions.get(name);
    if (!session) return;
    active = name;
    $('#terminalWorkspace').hidden = false;
    document.body.classList.add('terminal-open');
    for (const item of sessions.values()) item.pane.hidden = item !== session;
    $('#terminalPath').textContent = session.path;
    status(session, session.status || '正在连接…');
    showAccess(session);
    requestAnimationFrame(() => { fit(session); session.term.focus(); });
  }
  function connect(session, result) {
    const epoch = session.displayEpoch = (session.displayEpoch || 0) + 1;
    session.connectionKey = result.connectionKey;
    session.remoteSize = null;
    session.request = { ...session.request, mode: result.mode, sessionId: result.sessionId, account: result.account, preferredProcess: result.preferredProcess };
    session.account = result.account;
    session.displayQueue = session.displayQueue.then(() => { if (session.displayEpoch === epoch) session.term.reset(); });
    persist();
    session.closed = false;
    session.connected = false;
    session.normalExit = false;
    session.writable = false;
    session.blocked = !!result.readOnlyReason;
    session.accessReason = result.readOnlyReason || '';
    showAccess(session);
    status(session, '正在连接 HPC…');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/terminal/${result.connectionId}`, ['hpc-board', window.boardToken()]);
    session.socket = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ type: 'resize', cols: session.term.cols, rows: session.term.rows })); };
    ws.onmessage = event => {
      if (session.socket !== ws) return;
      const message = JSON.parse(event.data);
      if (message.type === 'output') session.displayQueue = session.displayQueue.then(() => session.displayEpoch === epoch ? new Promise(resolve => session.term.write(message.data, resolve)) : undefined);
      if (message.type === 'dimensions' || message.type === 'snapshot') {
        session.remoteSize = { cols: message.cols, rows: message.rows };
        session.displayQueue = session.displayQueue.then(async () => {
          if (session.displayEpoch !== epoch) return;
          if (message.type === 'snapshot') session.term.reset();
          session.term.resize(message.cols, message.rows);
          if (message.type === 'snapshot') await new Promise(resolve => session.term.write(message.data, resolve));
        });
      }
      if (message.type === 'ready') { session.connected = true; session.retries = 0; status(session, '已连接 HPC'); showAccess(session); }
      if (message.type === 'access') {
        const gained = !session.writable && message.writable;
        session.writable = message.writable; session.blocked = message.blocked; session.accessReason = message.writable ? '' : message.reason;
        showAccess(session); fit(session);
        if (gained && session.name === active) session.term.focus();
      }
      if (message.type === 'error') { session.term.writeln('\r\n' + message.message); status(session, '连接失败 · 可点击重连'); }
      if (message.type === 'exit') { session.normalExit = message.code === 0; session.term.writeln(`\r\n${message.code === 0 ? '此终端已断开。点击重连接回运行中的 Claude，或从原对话恢复。' : 'SSH 连接中断，请检查连接设置与网络。'}`); }
    };
    ws.onclose = () => {
      if (session.socket !== ws || session.closed) return;
      session.connected = false;
      session.writable = false;
      showAccess(session);
      status(session, '已断开 · 可点击重连');
      retryConnection(session);
    };
    ws.onerror = () => { /* close handles retry and preserves the terminal output */ };
  }
  async function reconnect(session, manual = true) {
    if (!session || session.closed || session.reconnecting) return;
    session.reconnecting = true;
    clearTimeout(session.retryTimer);
    if (manual) session.retries = 0;
    const old = session.socket; session.socket = null; old?.close();
    session.connected = false; session.writable = false; showAccess(session);
    status(session, '正在重新连接…');
    try {
      await window.boardReloadState();
      const result = await window.boardApi('launch', resumable(session.request));
      if (session.closed) return;
      connect(session, result);
    } catch (error) {
      if (session.closed) return;
      status(session, '重连失败 · 请检查连接');
      session.term.writeln('\r\n' + error.message);
      retryConnection(session);
    } finally { session.reconnecting = false; }
  }
  async function open(result, request) {
    if (!result.connectionId) return;
    if (sessions.has(result.terminal)) {
      const existing = sessions.get(result.terminal);
      if (result.replaceConnection || (result.connectionKey && result.connectionKey !== existing.connectionKey)) {
        clearTimeout(existing.retryTimer);
        const old = existing.socket; existing.socket = null; old?.close();
        existing.request = { ...request, mode: result.mode, sessionId: result.sessionId, account: result.account };
        existing.account = result.account; connect(existing, result); persist();
      }
      select(result.terminal);
      if (![WebSocket.OPEN, WebSocket.CONNECTING].includes(existing.socket?.readyState)) connect(existing, result);
      return;
    }
    const pane = document.createElement('div'); pane.className = 'terminal-pane'; pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-label', result.title + ' 终端');
    $('#terminalPanes').append(pane);
    const term = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: 'Consolas, "Microsoft YaHei", monospace', lineHeight: 1.12, scrollback: 7000, screenReaderMode: true, theme: { background: '#172019', foreground: '#dce5d4', cursor: '#c5ed97', selectionBackground: '#49643a88', black: '#172019', brightBlack: '#819477', green: '#a5ca77', brightGreen: '#c7ed9c' } });
    const fitter = new FitAddon.FitAddon(); term.loadAddon(fitter); term.open(pane);
    term.textarea.setAttribute('aria-label', `Claude 终端输入 ${result.title}`);
    const session = { name: result.terminal, title: result.title, path: result.path, account: result.account, request: { ...request, mode: result.mode, sessionId: result.sessionId, account: result.account }, term, fit: fitter, pane, connected: false, writable: false, displayQueue: Promise.resolve(), retries: 0, closed: false };
    sessions.set(session.name, session);
    term.onData(data => {
      if (!session.writable || session.closed || session.socket?.readyState !== WebSocket.OPEN) return;
      if (!validInput(data)) { window.boardToast?.('这段文字太长，请分段粘贴（每段不超过约 3 万字）。', true); return; }
      session.socket.send(JSON.stringify({ type: 'input', data }));
    });
    // tmux uses mouse reporting for scrollback; Shift+drag still selects locally.
    // Let the browser dispatch native copy/paste events, without sending ^C/^V.
    term.attachCustomKeyEventHandler(event => {
      const key = event.key.toLowerCase();
      const shortcut = (event.ctrlKey || event.metaKey) && !event.altKey;
      if (shortcut && key === 'c' && (event.shiftKey || term.hasSelection())) {
        if (event.shiftKey) {
          event.preventDefault();
          if (event.type === 'keydown') void copySelection(session);
        }
        return false;
      }
      if ((shortcut && key === 'v') || (event.shiftKey && key === 'insert' && !event.ctrlKey && !event.altKey && !event.metaKey)) return false;
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) { if (session.writable && session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'input', data: '\x1b\r' })); return false; }
      return true;
    });
    pane.addEventListener('paste', event => {
      // Capture before xterm: it only supports text, and must not silently discard
      // images or paste into a viewer that lost input ownership.
      if (!canPaste(session) || (!event.clipboardData?.getData('text/plain') && event.clipboardData?.files.length)) {
        event.preventDefault(); event.stopImmediatePropagation();
        window.boardToast?.(canPaste(session) ? '这里暂时只支持文字粘贴，图片不能直接传到 HPC。' : '当前终端不可输入，请先连接并接管输入。', true);
      }
    }, true);
    select(session.name); fit(session); connect(session, result); persist();
  }
  function close() {
    const session = sessions.get(active);
    if (!session) return;
    session.closed = true; clearTimeout(session.retryTimer); session.socket?.close(); session.term.dispose(); session.pane.remove(); sessions.delete(active);
    active = null; tabs(); persist();
    if (sessions.size) select([...sessions.keys()].at(-1)); else hide();
  }
  function hide() { $('#terminalWorkspace').hidden = true; document.body.classList.remove('terminal-open'); }
  new ResizeObserver(() => fit(sessions.get(active))).observe($('#terminalPanes'));
  $('#terminalTabs').addEventListener('click', event => { const tab = event.target.closest('[data-terminal]'); if (tab) select(tab.dataset.terminal); });
  $('#backToBoard').addEventListener('click', hide);
  $('#showTerminals').addEventListener('click', () => select(active || [...sessions.keys()][0]));
  $('#reconnectTerminal').addEventListener('click', () => reconnect(sessions.get(active)));
  $('#restartTerminal').addEventListener('click', () => { const session = sessions.get(active); if (session) window.restartSession(session.request); });
  $('#closeTerminal').addEventListener('click', close);
  $('#takeControl').addEventListener('click', () => { const session = sessions.get(active); if (session?.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'take-control' })); });
  $('#copyTerminal').addEventListener('click', () => { void copySelection(sessions.get(active)); });
  $('#pasteTerminal').addEventListener('click', () => {
    const session = sessions.get(active);
    if (canPaste(session)) clipboardDialog(session, '');
  });
  $('#insertClipboard').addEventListener('click', () => {
    const { session, socket } = clipboardSession || {};
    if (!canPaste(session) || session.socket !== socket) { $('#clipboardStatus').textContent = '连接或输入权已变化，文字仍保留在这里。请关闭此框，接回会话后重新粘贴。'; return; }
    const text = $('#clipboardText').value;
    if (!text) { $('#clipboardStatus').textContent = '请先粘贴文字。'; return; }
    // Include bracketed-paste overhead when validating the WebSocket limit.
    if (!validInput('\x1b[200~' + text.replace(/\r?\n/g, '\r') + '\x1b[201~')) { $('#clipboardStatus').textContent = '这段文字太长，请分段粘贴（每段不超过约 3 万字）。'; return; }
    session.term.paste(text);
    $('#clipboardDialog').close();
    session.term.focus();
  });
  $('#clipboardDialog').addEventListener('close', () => { $('#clipboardText').value = ''; clipboardSession = null; });
  $('#sessionLocations').addEventListener('click', () => { const session = sessions.get(active); if (session) window.showSessionLocations(session.request); });
  $('#terminalHistory').addEventListener('click', () => { const session = sessions.get(active); if (session) window.showProjectHistory(session.request.projectId); });
  window.BoardTerminals = { open, async reconnectAll() {
    await Promise.all([...sessions.values()].map(session => reconnect(session)));
  }, async restore() {
    let saved = []; try { saved = JSON.parse(sessionStorage.getItem('hpc-open-sessions') || '[]'); } catch {}
    pendingRestore = saved.slice(0, 12).map(resumable);
    const failures = [];
    for (const request of [...pendingRestore]) {
      try {
        await open(await window.boardApi('launch', request), request);
        pendingRestore = pendingRestore.filter(item => requestKey(item) !== requestKey(request));
      } catch (error) { failures.push(error.message); }
      persist();
    }
    if (failures.length) window.boardToast?.(`${failures.length} 个会话暂未接回，已保留入口：${failures[0]}`, true);
  } };
})();
