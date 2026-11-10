// Runs extension.js against a small fake "vscode" module and a temporary fake home folder.
// This checks the extension's behaviour without starting VS Code. Run with: npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const Module = require('module');

const root = path.join(__dirname, '..');
const extPath = path.join(root, 'extension.js');
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dancing-cat-ext-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
const claudeDir = path.join(fakeHome, '.claude');
const WATCH_WAIT = 1200; // the extension checks the state file every 300 ms

// ---------- a fake "vscode" module with just what the extension uses ----------
const calls = { info: [], warn: [], error: [] };
const commands = {};
const cfg = {};
let provider = null;
let winListeners = [];
let editorListeners = []; // the extension's "you switched editor / moved the cursor / scrolled" handlers
let decorationsDisposed = 0;
const statusItem = { text: '', visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
const disposable = { dispose() {} };
const Uri = { file: (p) => ({ fsPath: p, toString: () => 'file:///' + p }), parse: (s) => ({ toString: () => s }) };
class Range { constructor(a, b) { this.start = a; this.end = b; } }
const vscode = {
  Uri, Range,
  StatusBarAlignment: { Right: 2 }, DecorationRangeBehavior: { ClosedClosed: 1 }, ConfigurationTarget: { Global: 1 },
  window: {
    state: { focused: true },
    onDidChangeWindowState: (fn) => {
      winListeners.push(fn);
      return { dispose() { winListeners = winListeners.filter((f) => f !== fn); } };
    },
    createStatusBarItem: () => statusItem,
    registerWebviewViewProvider: (id, p) => { provider = p; return disposable; },
    onDidChangeActiveTextEditor: (fn) => { editorListeners.push(fn); return disposable; },
    onDidChangeTextEditorSelection: (fn) => { editorListeners.push(fn); return disposable; },
    onDidChangeTextEditorVisibleRanges: (fn) => { editorListeners.push(fn); return disposable; },
    showInformationMessage: (m) => { calls.info.push(m); return Promise.resolve(undefined); },
    showWarningMessage: (m) => { calls.warn.push(m); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { calls.error.push(m); return Promise.resolve(undefined); },
    showQuickPick: () => Promise.resolve(undefined),
    showOpenDialog: () => Promise.resolve(undefined),
    createTextEditorDecorationType: () => ({ dispose() { decorationsDisposed++; } }),
    activeTextEditor: undefined,
    visibleTextEditors: []
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in cfg ? cfg[k] : d), update: async (k, v) => { cfg[k] = v; } })
  },
  commands: {
    registerCommand: (id, fn) => { commands[id] = fn; return disposable; },
    executeCommand: () => Promise.resolve()
  },
  env: { openExternal: () => Promise.resolve(true) }
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, ...rest);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let panelShown = 0;
const view = {
  webview: {
    options: null, html: '', cspSource: 'vscode-csp',
    asWebviewUri: (u) => ({ toString: () => 'https://webview/' + u.fsPath.replace(/\\/g, '/') })
  },
  show() { panelShown++; },
  onDidDispose() {}
};
let passed = 0;
const step = (name) => { passed++; console.log('ok -', name); };
const setupPrompts = () => calls.info.filter((m) => m.includes('needs a few small hooks')).length;
const builtInCatShown = () => /media\/[^"]+\.webp/.test(view.webview.html);

// Each "window" loads its own copy of the extension; globalState is shared between windows like in VS Code
function openWindow(globalState) {
  delete require.cache[require.resolve(extPath)];
  editorListeners = [];
  const ext = require(extPath);
  const context = {
    extensionPath: root,
    subscriptions: [],
    globalState: {
      get: (k, d) => (globalState.has(k) ? globalState.get(k) : d),
      update: async (k, v) => globalState.set(k, v)
    }
  };
  ext.activate(context);
  return { close() { context.subscriptions.forEach((d) => d.dispose()); ext.deactivate(); } };
}

(async () => {
  const pkg = require(path.join(root, 'package.json'));
  const shared = new Map();

  let win = openWindow(shared);           // first start, focused window -> asks
  await sleep(50);
  assert.strictEqual(setupPrompts(), 1);
  assert.ok(fs.existsSync(path.join(claudeDir, 'dancing-cat.state')));
  win.close();
  win = openWindow(shared);               // another window the same day -> doesn't ask again
  await sleep(50);
  assert.strictEqual(setupPrompts(), 1);
  win.close();
  vscode.window.state.focused = false;    // fresh install in a window you're not using -> waits
  win = openWindow(new Map());
  await sleep(50);
  assert.strictEqual(setupPrompts(), 1, 'a window you are not using must not ask');
  vscode.window.state.focused = true;
  winListeners.forEach((fn) => fn({ focused: true }));
  await sleep(50);
  assert.strictEqual(setupPrompts(), 2, 'asks once you switch to that window');
  step('setup message: only in the window you are using, and at most once a day');

  for (const c of pkg.contributes.commands) assert.ok(commands[c.command], 'registered: ' + c.command);
  assert.strictEqual(Object.keys(commands).length, pkg.contributes.commands.length);
  step(`all ${pkg.contributes.commands.length} commands in package.json are registered (and no extra ones)`);

  provider.resolveWebviewView(view);
  assert.ok(view.webview.html.includes('class="napping"'));
  assert.ok(view.webview.html.includes('sleeping-cat.webp'));
  assert.strictEqual(view.webview.options.enableScripts, false);
  step('the panel shows the sleeping cat while Claude is idle');

  commands['dancingCat.test']();
  assert.ok(view.webview.html.includes('class="dancing"'));
  assert.ok(builtInCatShown(), 'a built-in cat is shown');
  assert.ok(statusItem.visible && statusItem.text.includes('dancing'));
  step('Test Dance shows a built-in cat and the status bar item');

  commands['dancingCat.stop']();
  assert.ok(view.webview.html.includes('class="napping"') && !statusItem.visible);
  assert.strictEqual(fs.readFileSync(path.join(claudeDir, 'dancing-cat.state'), 'utf8'), 'idle');
  step('Stop Dancing puts the cat to sleep and writes "idle"');

  const stateFile = path.join(claudeDir, 'dancing-cat.state');
  fs.writeFileSync(stateFile, 'thinking'); await sleep(WATCH_WAIT);
  assert.ok(view.webview.html.includes('class="dancing"'), '"thinking" makes it dance');
  fs.writeFileSync(stateFile, 'idle'); await sleep(WATCH_WAIT);
  assert.ok(view.webview.html.includes('class="napping"'), '"idle" makes it nap');
  step('reacts to the state file written by the Claude Code hooks');

  const myCats = path.join(fakeHome, 'my cats');
  fs.mkdirSync(myCats);
  const anyCat = fs.readdirSync(path.join(root, 'media'))[0];
  fs.copyFileSync(path.join(root, 'media', anyCat), path.join(myCats, 'my-cat.webp'));
  for (const setting of [myCats, 'my cats', '~/my cats', '~\\my cats']) {
    cfg.catsFolder = setting;
    commands['dancingCat.test']();
    assert.ok(view.webview.html.includes('my-cat.webp'), 'uses my cat with setting: ' + setting);
    assert.ok(view.webview.options.localResourceRoots.some((u) => u.fsPath === myCats), 'panel may load: ' + setting);
    commands['dancingCat.stop']();
  }
  cfg.catsFolder = path.join(myCats, 'does-not-exist');
  commands['dancingCat.test']();
  assert.ok(builtInCatShown(), 'falls back to the built-in cats');
  commands['dancingCat.stop']();
  delete cfg.catsFolder;
  step('own cats folder works with full, relative and ~ paths, and falls back to the built-in cats');

  const decorated = new Map();
  const makeEditor = (scheme, name = scheme) => ({
    document: { uri: { scheme } },
    selection: { active: { line: 3, character: 2 } },
    visibleRanges: [{ start: { line: 0, character: 0 }, end: { line: 40, character: 0 }, contains: () => true }],
    setDecorations(type, ranges) { if (ranges.length) decorated.set(name, (decorated.get(name) || 0) + 1); }
  });
  const code = makeEditor('file');
  const output = makeEditor('output');
  cfg.showIn = 'editor';
  vscode.window.activeTextEditor = output;  // you clicked into the Output panel last
  vscode.window.visibleTextEditors = [output, code];
  panelShown = 0;
  const panelHasCat = () => /<img class="cat"/.test(view.webview.html);
  commands['dancingCat.test']();
  assert.ok(decorated.get('file') >= 1, 'floating cat placed in the code file');
  assert.ok(!decorated.get('output'), 'never in the Output panel');
  assert.strictEqual(panelShown, 0, 'panel not forced open in editor mode');
  assert.ok(!panelHasCat(), 'editor mode: no second cat in the panel');
  assert.strictEqual((view.webview.html.match(/class="paw"/g) || []).length, 5, 'panel shows a trail of 5 paw prints');
  assert.ok(/<p>[^<]*(code|dance floor|dancing)[^<]*<\/p>/.test(view.webview.html), 'panel says where the cat went');
  // the code file gets closed while the cat dances -> the panel takes over
  vscode.window.activeTextEditor = output;
  vscode.window.visibleTextEditors = [output];
  editorListeners.forEach((fn) => fn());
  assert.ok(panelHasCat(), 'no code file visible: the cat moves to the panel');
  assert.strictEqual(panelShown, 1, 'panel opened as the fallback');
  // and a code file comes back -> floating again, panel empty again
  vscode.window.activeTextEditor = code;
  vscode.window.visibleTextEditors = [code];
  editorListeners.forEach((fn) => fn());
  assert.ok(!panelHasCat(), 'code file back: the cat floats again, not in the panel');
  commands['dancingCat.stop']();
  assert.strictEqual(decorationsDisposed, 2, 'floating cat removed when napping');
  assert.ok(view.webview.html.includes('sleeping-cat.webp'), 'napping cat in the panel afterwards');
  vscode.window.activeTextEditor = output;
  vscode.window.visibleTextEditors = [output];  // only the Output panel is open
  commands['dancingCat.test']();
  assert.ok(!decorated.get('output'), 'still never in the Output panel');
  assert.ok(panelHasCat(), 'no code file: the cat dances in the panel');
  assert.strictEqual(panelShown, 2, 'falls back to the panel');
  commands['dancingCat.stop']();
  // "both": floating and in the panel
  cfg.showIn = 'both';
  vscode.window.activeTextEditor = code;
  vscode.window.visibleTextEditors = [code];
  const before = decorated.get('file');
  commands['dancingCat.test']();
  assert.ok(decorated.get('file') > before, 'both: floating cat placed');
  assert.ok(panelHasCat(), 'both: cat also in the panel');
  commands['dancingCat.stop']();

  // you're typing to Claude (no active editor) and a diff view is open:
  // its hidden "old version" side (git) comes first in the list, the real file second
  cfg.showIn = 'editor';
  const gitSide = makeEditor('git', 'diff-old-side');
  const diffFile = makeEditor('file', 'diff-real-file');
  vscode.window.activeTextEditor = undefined;
  vscode.window.visibleTextEditors = [gitSide, diffFile];
  commands['dancingCat.test']();
  assert.ok(decorated.get('diff-real-file') >= 1, 'diff view: the cat floats in the real file');
  assert.ok(!decorated.get('diff-old-side'), 'diff view: never in the hidden old-version side');
  commands['dancingCat.stop']();

  // two files side by side: the cat goes to the one you used last, even after you click into Claude
  const left = makeEditor('file', 'left-file');
  const right = makeEditor('file', 'right-file');
  vscode.window.visibleTextEditors = [left, right];
  vscode.window.activeTextEditor = right;
  editorListeners.forEach((fn) => fn(right));  // you clicked into the right file
  vscode.window.activeTextEditor = undefined;  // ...then into the Claude chat
  commands['dancingCat.test']();
  assert.ok(decorated.get('right-file') >= 1, 'floats in the editor you used last');
  assert.ok(!decorated.get('left-file'), 'not in the other one');
  commands['dancingCat.stop']();

  vscode.window.activeTextEditor = undefined;
  vscode.window.visibleTextEditors = [];
  delete cfg.showIn;
  step('floating cat: code files only, no second cat in the panel in editor mode, panel takes over when needed, "both" shows both');

  const settingsFile = path.join(claudeDir, 'settings.json');
  await commands['dancingCat.installHooks']();
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks).sort(),
    ['SessionEnd', 'Stop', 'UserPromptSubmit']);
  assert.ok(calls.info.some((m) => m.includes('Hooks installed')), 'success message (Node.js found)');
  await commands['dancingCat.removeHooks']();
  assert.ok(!fs.readFileSync(settingsFile, 'utf8').includes('dancing-cat'));
  step('Install / Remove Claude Code Hooks commands work');

  fs.writeFileSync(settingsFile, '{ // comment\n}');
  await commands['dancingCat.installHooks']();
  assert.ok(calls.error.some((m) => m.includes("couldn't install") && m.includes('were not changed')));
  assert.strictEqual(fs.readFileSync(settingsFile, 'utf8'), '{ // comment\n}');
  step('unreadable Claude settings: shows an error and changes nothing');

  win.close();
  fs.rmSync(fakeHome, { recursive: true, force: true });
  console.log(`\nextension: all ${passed} checks passed`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
