import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/web-terminal.js', import.meta.url), 'utf8');
async function fixture({ denyClipboard = false } = {}) {
  class Element {
    hidden = false; value = ''; textContent = ''; listeners = new Map();
    classList = { toggle() {}, add() {}, remove() {} };
    setAttribute() {} append() {} focus() {} select() { this.selected = true; } remove() {}
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    fire(type, event = {}) { return this.listeners.get(type)?.(event); }
    showModal() { this.open = true; }
    close() { this.open = false; this.fire('close'); }
  }
  const elements = new Map(), terms = [], sockets = [], copies = [], notices = [], timers = [];
  const element = name => { if (!elements.has(name)) elements.set(name, new Element()); return elements.get(name); };
  class Terminal {
    options = {}; textarea = new Element(); cols = 100; rows = 30; selection = ''; pastes = [];
    constructor() { terms.push(this); }
    loadAddon() {} open(pane) { this.pane = pane; } reset() {} resize() {} focus() {} dispose() {}
    write(data, done) { done?.(); } writeln() {}
    getSelection() { return this.selection; } hasSelection() { return !!this.selection; }
    onData(callback) { this.data = callback; }
    attachCustomKeyEventHandler(callback) { this.key = callback; }
    paste(text) { this.pastes.push(text); this.data(text); }
  }
  class WebSocket {
    static OPEN = 1; static CONNECTING = 0; readyState = 1; sent = [];
    constructor() { sockets.push(this); }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    receive(value) { this.onmessage({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const window = { boardToken: () => 'test', boardToast: (...args) => notices.push(args) };
  vm.runInNewContext(source, {
    window, Terminal, WebSocket, TextEncoder,
    document: { querySelector: element, createElement: () => new Element(), body: new Element() },
    navigator: { clipboard: { writeText: async text => { if (denyClipboard) throw new Error('Denied'); copies.push(text); } } },
    sessionStorage: { setItem() {}, getItem() { return '[]'; } },
    location: { protocol: 'http:', host: '127.0.0.1' },
    ResizeObserver: class { observe() {} }, FitAddon: { FitAddon: class { fit() {} } },
    requestAnimationFrame: callback => callback(),
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
  });
  async function open(name) {
    await window.BoardTerminals.open({ connectionId: name, terminal: name, title: name, path: '/test', mode: 'resume', sessionId: name, account: 'claude' }, { projectId: name });
    const socket = sockets.at(-1), term = terms.at(-1);
    socket.receive({ type: 'ready' }); socket.receive({ type: 'access', writable: true });
    return { socket, term };
  }
  return { element, copies, notices, timers, sockets, window, open, ...await open('first') };
}
function key(key, options = {}) {
  return { key, type: 'keydown', ctrlKey: true, preventDefault() { this.prevented = true; }, ...options };
}

test('selected Ctrl+C is native copy; unselected Ctrl+C retains interruption; paste shortcuts never become terminal control codes', async () => {
  const f = await fixture();
  assert.equal(f.term.key(key('c')), true);
  f.term.selection = '中文 sample';
  const copy = key('c');
  assert.equal(f.term.key(copy), false); assert.equal(copy.prevented, undefined);
  for (const event of [key('v'), key('V', { shiftKey: true }), key('Insert', { ctrlKey: false, shiftKey: true })]) {
    assert.equal(f.term.key(event), false); assert.equal(event.prevented, undefined);
  }
  assert.equal(f.socket.sent.filter(m => m.type === 'input').length, 0);
  const explicit = key('C', { shiftKey: true });
  assert.equal(f.term.key(explicit), false); assert.equal(explicit.prevented, true);
  await Promise.resolve(); assert.deepEqual(f.copies, ['中文 sample']);
});

test('copy works read-only and falls back to a selectable textbox if clipboard permission is denied', async () => {
  const f = await fixture({ denyClipboard: true });
  f.socket.receive({ type: 'access', writable: false });
  f.term.selection = '原对话\n第二行';
  f.element('#copyTerminal').fire('click'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.element('#clipboardDialog').open, true);
  assert.equal(f.element('#clipboardText').value, '原对话\n第二行');
  assert.equal(f.element('#clipboardText').readOnly, true);
  assert.equal(f.element('#clipboardText').selected, true);
  assert.equal(f.element('#insertClipboard').hidden, true);
  assert.equal(f.element('#pasteTerminal').disabled, true);
  assert.equal(f.socket.sent.filter(m => m.type === 'input').length, 0);
});

test('paste dialog invokes terminal paste once, preserves multiline text and adds no Enter', async () => {
  const f = await fixture();
  f.element('#pasteTerminal').fire('click');
  const sample = '第一行\nsecond line';
  f.element('#clipboardText').value = sample;
  f.element('#insertClipboard').fire('click');
  assert.deepEqual(f.term.pastes, [sample]);
  assert.equal(f.socket.sent.filter(m => m.type === 'input').length, 1);
  assert.equal(f.element('#clipboardDialog').open, false);
  assert.equal(f.element('#clipboardText').value, '');
});

test('an open paste dialog cannot send to a different tab or a session that lost ownership', async () => {
  const f = await fixture();
  f.element('#pasteTerminal').fire('click'); f.element('#clipboardText').value = 'keep this draft';
  const second = await f.open('second');
  f.socket.receive({ type: 'access', writable: false });
  f.element('#insertClipboard').fire('click');
  assert.equal(f.term.pastes.length, 0); assert.equal(second.term.pastes.length, 0);
  assert.equal(f.element('#clipboardText').value, 'keep this draft');
  assert.equal(f.element('#clipboardDialog').open, true);
  assert.match(f.element('#clipboardStatus').textContent, /输入权已变化/);
  f.term.data('read-only input');
  assert.equal(f.socket.sent.filter(m => m.type === 'input').length, 0);
});

test('oversized Unicode paste is rejected before WebSocket disconnect; readonly native paste is blocked', async () => {
  const f = await fixture();
  f.element('#pasteTerminal').fire('click'); f.element('#clipboardText').value = '字'.repeat(50000);
  f.element('#insertClipboard').fire('click');
  assert.equal(f.term.pastes.length, 0); assert.match(f.element('#clipboardStatus').textContent, /太长/);
  f.term.data('字'.repeat(50000));
  assert.equal(f.socket.sent.filter(m => m.type === 'input').length, 0);
  f.socket.receive({ type: 'access', writable: false });
  const event = { preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  f.term.pane.fire('paste', event);
  assert.equal(event.prevented, true); assert.equal(event.stopped, true);
});

test('a service outage during reconnect retries the HTTP launch after recovery instead of staying disconnected', async () => {
  const f = await fixture();
  let reloads = 0, launches = 0;
  f.window.boardReloadState = async () => { if (++reloads === 1) throw Error('Service still restarting'); };
  f.window.boardApi = async () => { launches++; return {connectionId:'replacement',terminal:'first',title:'first',mode:'resume',sessionId:'first',account:'claude'}; };
  f.socket.close();
  assert.equal(f.timers.at(-1).delay, 2000);
  await f.timers.at(-1).callback();
  assert.equal(launches, 0); assert.equal(f.timers.at(-1).delay, 4000);
  await f.timers.at(-1).callback();
  assert.equal(launches, 1); assert.equal(f.sockets.length, 2);
  const replacement = f.sockets.at(-1);
  replacement.receive({type:'ready'}); replacement.receive({type:'access',writable:true});
  assert.equal(f.element('#terminalConnection').textContent, '已连接 HPC');
  assert.equal(f.element('#pasteTerminal').disabled, false);
  replacement.close();
  assert.equal(f.timers.at(-1).delay, 2000, 'successful recovery resets retry backoff');
});
