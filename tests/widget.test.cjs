const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

class PhysicalPosition { constructor(x, y) { this.x = x; this.y = y; } }
class PhysicalSize {
  constructor(width, height) { this.width = width; this.height = height; }
  toLogical(scale) { return new LogicalSize(this.width / scale, this.height / scale); }
}
class LogicalSize { constructor(width, height) { this.width = width; this.height = height; } }

function load(file, requireModule, globals = {}) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { module: mod, exports: mod.exports, require: requireModule, ...globals });
  return mod.exports;
}

const layout = load('src/windowLayout.ts', () => ({ PhysicalPosition, PhysicalSize, LogicalSize }));
function windowFixture() {
  const scale = 1.5;
  let position = new PhysicalPosition(180, 120);
  let size = new PhysicalSize(450, 510);
  let resizable = true;
  const monitor = {
    scaleFactor: scale,
    workArea: { position: new PhysicalPosition(-1920, 0), size: new PhysicalSize(1920, 1040) },
  };
  const window = {
    outerPosition: async () => position,
    innerSize: async () => size,
    outerSize: async () => size,
    isResizable: async () => resizable,
    scaleFactor: async () => scale,
    setMinSize: async () => {},
    setSize: async next => { size = next instanceof LogicalSize ? new PhysicalSize(next.width * scale, next.height * scale) : next; },
    setPosition: async next => { position = next; },
    setResizable: async next => { resizable = next; },
  };
  return { window, monitor };
}

test('compact docking respects monitor DPI, negative coordinates and taskbar work area; unpin restores geometry', async () => {
  const { window, monitor } = windowFixture();
  const original = await layout.captureView(window);
  await layout.dockCompact(window, monitor, 160);
  assert.equal((await window.innerSize()).width, 390);
  assert.equal((await window.outerPosition()).x, -408);
  assert.equal((await window.outerPosition()).y, 782);
  assert.equal(await window.isResizable(), false);
  await window.setPosition(new PhysicalPosition(0, 0));
  await layout.anchorCompact(window, monitor);
  assert.equal((await window.outerPosition()).x, -408);
  await layout.restoreView(window, original);
  assert.equal((await window.innerSize()).height, 510);
  assert.equal((await window.outerPosition()).x, 180);
  assert.equal(await window.isResizable(), true);
  await layout.fitDetails(window, 620);
  assert.equal((await window.innerSize()).toLogical(1.5).height, 620);
});

function widgetFixture(overrides = {}, storage = {}) {
  const values = [], refs = [], calls = [];
  let cursor = 0, refCursor = 0;
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial;
      return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }];
    },
    useRef(initial) { const i = refCursor++; return refs[i] ?? (refs[i] = { current: initial }); },
    useEffect() {},
    useCallback(fn) { return fn; },
  };
  const emails = ['work@example.com', 'personal@example.com', 'third@example.com', 'fourth@example.com'];
  const cache = Object.fromEntries(emails.map(email => ['codex:' + email, {
    accountEmail: email, plan: 'plus', source: 'Codex account', updatedAt: Math.floor(Date.now() / 1000),
    windows: [{ label: 'Session', usedPercent: 20, resetsAt: null }, { label: 'Weekly', usedPercent: 10, resetsAt: null }],
  }]));
  const { window, monitor } = windowFixture();
  const localStorage = { getItem: key => key in storage ? storage[key] : JSON.stringify(cache), setItem() {}, removeItem() {} };
  const plan = load('src/plan.ts', () => ({}), { localStorage });
  const App = load('src/App.tsx', id => {
    if (id === 'react') return hooks;
    if (id === 'react/jsx-runtime') return require(id);
    if (id === './windowLayout') return layout;
    if (id === './plan') return plan;
    if (id === '@tauri-apps/api/core') return { isTauri: () => true, invoke: async (name, args) => {
      calls.push({ name, args });
      if (overrides[name]) return overrides[name](args);
      if (name === 'codex_account') return 'work@example.com';
      if (name === 'codex_usage') return cache['codex:work@example.com'];
      if (name === 'claude_usage') return { ...cache['codex:work@example.com'], accountEmail: null };
    } };
    if (id === '@tauri-apps/api/window') return { getCurrentWindow: () => window, currentMonitor: async () => monitor, primaryMonitor: async () => monitor };
    if (id === '@tauri-apps/plugin-opener' || id === './App.css') return {};
    throw new Error(id);
  }, { localStorage }).default;
  function render() { cursor = 0; refCursor = 0; return App(); }
  function nodes(node, out = []) {
    if (Array.isArray(node)) for (const child of node) nodes(child, out);
    else if (node && typeof node === 'object' && node.props) { out.push(node); nodes(node.props.children, out); }
    return out;
  }
  const find = (tree, label) => nodes(tree).find(node => node.props['aria-label'] === label);
  const select = (tree, email) => nodes(tree).find(node => node.props.className === 'account-select' && node.props.children === email).props.onClick({ stopPropagation() {} });
  render();
  refs[1].current = true; // The mounted effect is omitted by this component harness.
  values[3] = 'work@example.com';
  values[0]['codex:work@example.com'].active = true;
  return { render, nodes, find, select, calls, window, refs };
}

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

test('free plan stops adding a third Codex account and offers Pro; switching saved accounts still signs in', async () => {
  const fixture = widgetFixture();
  let tree = fixture.render();
  fixture.find(tree, 'Switch or add Codex account').props.onClick();
  await settle();
  assert(!fixture.calls.some(call => call.name === 'codex_login_start'));
  tree = fixture.render();
  const panel = fixture.find(tree, 'TokenPulse Pro');
  assert(panel);
  const buttons = fixture.nodes(panel).filter(node => node.type === 'button');
  assert.equal(buttons.filter(button => button.props.role === 'radio').length, 2);
  assert.equal(buttons.find(button => button.props.className === 'upgrade-cta').props.disabled, true, 'checkout waits for payments');
  buttons.find(button => button.props.children === 'Switch to a saved account').props.onClick();
  await settle();
  assert(fixture.calls.some(call => call.name === 'codex_login_start'));
});

test('header Free badge opens Pro without a limit message; Pro shows a static badge', () => {
  const fixture = widgetFixture();
  fixture.find(fixture.render(), 'Free plan · see Pro').props.onClick();
  const panel = fixture.find(fixture.render(), 'TokenPulse Pro');
  assert(panel);
  assert(!fixture.nodes(panel).some(node => node.props.className === 'upgrade-switch'));
  const pro = widgetFixture({}, { 'usage-widget.license.v1': JSON.stringify({ tier: 'pro' }) });
  const tree = pro.render();
  assert(!pro.find(tree, 'Free plan · see Pro'));
  assert(pro.nodes(tree).some(node => node.props.className === 'plan-badge pro'));
});

test('Pro license allows adding more Codex accounts', async () => {
  const fixture = widgetFixture({}, { 'usage-widget.license.v1': JSON.stringify({ tier: 'pro' }) });
  const tree = fixture.render();
  fixture.find(tree, 'Switch or add Codex account').props.onClick();
  await settle();
  assert(fixture.calls.some(call => call.name === 'codex_login_start'));
  assert(!fixture.find(fixture.render(), 'TokenPulse Pro'));
});

test('a previous Claude account stays as a saved reading and disconnects without signing out the live one', async () => {
  let claudeUser = 'a@example.com';
  const fixture = widgetFixture({ claude_account: () => claudeUser });
  fixture.find(fixture.render(), 'Refresh usage').props.onClick();
  await settle();
  claudeUser = 'b@example.com';
  fixture.refs[2].current = 0; // Skip the manual refresh cooldown.
  fixture.find(fixture.render(), 'Refresh usage').props.onClick();
  await settle();
  let tree = fixture.render();
  assert.equal(fixture.nodes(tree).filter(node => node.type === 'section').length, 6);
  assert.match(fixture.find(tree, 'a@example.com usage').props.className, /\bsaved\b/);
  assert.doesNotMatch(fixture.find(tree, 'b@example.com usage').props.className, /\bsaved\b/);
  fixture.select(tree, 'a@example.com');
  tree = fixture.render();
  fixture.find(tree, 'Disconnect a@example.com').props.onClick({ stopPropagation() {} });
  await settle();
  assert(!fixture.calls.some(call => call.name === 'claude_logout'));
  tree = fixture.render();
  assert(!fixture.find(tree, 'a@example.com usage'));
  assert(fixture.find(tree, 'b@example.com usage'));
});

test('all accounts remain visible; pin shows usage summary and unpin restores breakdown', async () => {
  const fixture = widgetFixture();
  let tree = fixture.render();
  assert.equal(fixture.nodes(tree).filter(node => node.type === 'section').length, 5);
  assert(!fixture.find(tree, 'Account pages'));
  await fixture.find(tree, 'Pin compact widget to bottom right').props.onClick();
  // UI event wrappers launch an async action; wait for its serialized window operations.
  await new Promise(resolve => setImmediate(resolve));
  tree = fixture.render();
  assert.equal(tree.props.className, 'widget compact');
  assert.equal(fixture.nodes(tree).filter(node => node.type === 'section').length, 5);
  assert(!fixture.nodes(tree).some(node => node.props.className === 'window-details'));
  fixture.find(tree, 'Unpin and show details').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = fixture.render();
  assert.equal(tree.props.className, 'widget');
  assert(fixture.nodes(tree).some(node => node.props.className === 'window-details'));
  assert.equal((await fixture.window.outerPosition()).x, 180);
});

test('selected live account can disconnect during refresh, after the reader finishes', async () => {
  let finishRead;
  const blockedRead = new Promise(resolve => { finishRead = resolve; });
  const fixture = widgetFixture({ codex_usage: () => blockedRead });
  let tree = fixture.render();
  fixture.find(tree, 'Refresh usage').props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  tree = fixture.render();
  fixture.select(tree, 'work@example.com');
  tree = fixture.render();
  const disconnect = fixture.find(tree, 'Disconnect work@example.com');
  assert.equal(disconnect.props.disabled, false);
  disconnect.props.onClick({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert(!fixture.calls.some(call => call.name === 'codex_logout'));
  finishRead({ accountEmail: 'work@example.com', windows: [], updatedAt: 1, source: 'Codex account' });
  await new Promise(resolve => setImmediate(resolve));
  const logout = fixture.calls.find(call => call.name === 'codex_logout');
  assert.equal(logout.args.expectedEmail, 'work@example.com');
  assert(!fixture.find(fixture.render(), 'work@example.com usage'));
});

test('disconnecting a saved account removes its card without logging out the live account', async () => {
  const fixture = widgetFixture();
  let tree = fixture.render();
  fixture.select(tree, 'personal@example.com');
  tree = fixture.render();
  fixture.find(tree, 'Disconnect personal@example.com').props.onClick({ stopPropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert(!fixture.calls.some(call => call.name === 'codex_logout'));
  tree = fixture.render();
  assert(!fixture.find(tree, 'personal@example.com usage'));
  assert(fixture.find(tree, 'work@example.com usage'));
});
