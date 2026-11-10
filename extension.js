const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const hooks = require('./hooks');

const STATE_FILE = hooks.STATE_FILE;  // the hooks write "thinking" / "idle" here
const VIEW_ID = 'dancingCat.view';    // the "Dancing Cat" tab in the bottom panel (see package.json)
const FLOAT_HEIGHT = 180;             // size (px) of the cat floating in the code editor
const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
const DONT_ASK_SETUP = 'dancingCat.dontAskSetup';
const SETUP_ASKED_AT = 'dancingCat.setupAskedAt';
const ONE_DAY = 24 * 60 * 60 * 1000;

const DANCES = ['wiggle', 'spin', 'bounce', 'moonwalk', 'disco'];
const MESSAGES = [
  'Claude is thinking… the cat is dancing',
  'Busting moves while the tokens flow',
  'Thinking hard, dancing harder',
  'Cat.exe is grooving',
  'Hold on, it’s a long song'
];
const NAP_MESSAGE = 'Cat is napping… send Claude a prompt to wake it up';

let view = null;        // the panel's webview (null until VS Code first shows it)
let mediaDir = null;    // built-in cats
let sleepFile = null;   // resources/sleeping-cat.webp, shown while Claude is idle
let thinking = false;   // is Claude working right now?
let catPath = null;     // full path of the picture currently shown
let dance = null;       // CSS dance for still pictures (animated ones dance on their own)
let message = NAP_MESSAGE;
let statusItem = null;
let statusTimer = null;
let floatTypes = null;  // { below, above } decorations for the cat floating in the editor
let floatEditor = null; // the editor the floating cat is in

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const config = () => vscode.workspace.getConfiguration('dancingCat');
const showIn = () => config().get('showIn', 'panel');

function activate(context) {
  mediaDir = path.join(context.extensionPath, 'media');
  sleepFile = path.join(context.extensionPath, 'resources', 'sleeping-cat.webp');
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, 'idle');
  } catch { /* can't write to ~/.claude: the cat just won't hear from Claude */ }

  // Status bar: shows while the cat dances; click it to stop (e.g. after pressing Esc in Claude)
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'dancingCat.stop';
  statusItem.tooltip = 'Click to stop the dance (useful if you pressed Esc in Claude)';
  context.subscriptions.push(statusItem);

  // VS Code calls this when the Dancing Cat tab becomes visible
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, {
      resolveWebviewView(webviewView) {
        view = webviewView;
        view.onDidDispose(() => { view = null; });
        render();
      }
    })
  );

  // The floating cat follows your cursor, the editor you switch to, and scrolling
  const follow = () => { if (floatTypes) placeFloatingCat(); };
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(follow),
    vscode.window.onDidChangeTextEditorSelection(follow),
    vscode.window.onDidChangeTextEditorVisibleRanges(follow),
    { dispose: stopFloating }
  );

  // Always start napping (an old "thinking" left over from a closed Claude shouldn't make it dance)
  napping();

  // Watch the state file the Claude Code hooks write to
  let last = readState();
  fs.watchFile(STATE_FILE, { interval: 300 }, () => {
    const now = readState();
    if (now === last) return;
    last = now;
    if (now === 'thinking') startDancing();
    else napping();
  });
  context.subscriptions.push({ dispose: () => fs.unwatchFile(STATE_FILE) });

  context.subscriptions.push(
    vscode.commands.registerCommand('dancingCat.test', () => {
      startDancing();
      // after 5 seconds go back to napping, unless Claude really started thinking meanwhile
      setTimeout(() => { if (readState() !== 'thinking') napping(); }, 5000);
    }),
    vscode.commands.registerCommand('dancingCat.stop', stopDancing),
    vscode.commands.registerCommand('dancingCat.choosePosition', choosePosition),
    vscode.commands.registerCommand('dancingCat.chooseCatsFolder', chooseCatsFolder),
    vscode.commands.registerCommand('dancingCat.installHooks', installHooksCommand),
    vscode.commands.registerCommand('dancingCat.removeHooks', removeHooksCommand)
  );

  offerSetup(context);
}

function readState() {
  try { return fs.readFileSync(STATE_FILE, 'utf8').trim(); } catch { return 'idle'; }
}

// ---------- Which cats ----------

// The folder the user picked for their own cats, or null to use the built-in ones.
// "~/cats" and relative paths like "cats" are counted from the home folder.
function customFolder() {
  let dir = (config().get('catsFolder') || '').trim();
  if (!dir) return null;
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) dir = dir.slice(1).replace(/^[\\/]/, '');
  return path.isAbsolute(dir) ? dir : path.join(os.homedir(), dir);
}

function picturesIn(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => PICTURE.test(f)).map((f) => path.join(dir, f));
  } catch { return []; }
}

// Full paths of the cats to choose from: the user's folder if it has any, otherwise the built-in ones
function listCats() {
  const dir = customFolder();
  const mine = dir ? picturesIn(dir) : [];
  return mine.length ? mine : picturesIn(mediaDir);
}

// ---------- Dancing and napping ----------

function startDancing() {
  // Prefer moving cats (GIF / animated WebP): if there are any, only pick from them
  const all = listCats();
  const movers = all.filter(isAnimated);
  const cats = movers.length ? movers : all;
  catPath = cats.length ? pick(cats) : null;
  dance = catPath && !isAnimated(catPath) ? pick(DANCES) : null;
  message = pick(MESSAGES);
  thinking = true;
  render();

  const where = showIn();
  const floating = where !== 'panel' && catPath && startFloating(catPath);
  // Show the panel if asked to, or as a backup when there's no code file open to float in
  if (where !== 'editor' || !floating) reveal();

  // little animated cat in the status bar too
  const frames = ['$(loading~spin) Cat is dancing ♪', '$(loading~spin) Cat is dancing ♫'];
  let i = 0;
  statusItem.text = frames[0];
  statusItem.show();
  clearInterval(statusTimer);
  statusTimer = setInterval(() => { statusItem.text = frames[i++ % frames.length]; }, 300);
}

// Claude is done: the cat stays in the panel and naps.
// Uses resources/sleeping-cat.webp, or else a still picture, or else a 😴 emoji.
function napping() {
  thinking = false;
  stopFloating();
  const stills = listCats().filter((f) => !isAnimated(f));
  catPath = fs.existsSync(sleepFile) ? sleepFile : stills.length ? pick(stills) : null;
  dance = null;
  message = NAP_MESSAGE;
  render();
  clearInterval(statusTimer);
  if (statusItem) statusItem.hide();
}

// "Dancing Cat: Stop Dancing" (also when you click the status bar cat).
// Claude Code doesn't run its "Stop" hook when you interrupt it with Esc, so this is the way out.
function stopDancing() {
  try { fs.writeFileSync(STATE_FILE, 'idle'); } catch { /* ignore */ }
  napping();
}

// Bring the Dancing Cat tab to the front without taking your cursor
function reveal() {
  if (view) view.show(true);
  else vscode.commands.executeCommand(`${VIEW_ID}.focus`, { preserveFocus: true }).then(undefined, () => {});
}

// ---------- The cat floating inside the code editor (experimental) ----------
// VS Code has no official "float a picture over the code" feature. Like Power Mode,
// this puts the picture in an editor decoration and adds a little extra CSS so it floats
// next to the cursor without pushing your code around.

function startFloating(full) {
  stopFloating();
  const size = imageSize(full) || { width: FLOAT_HEIGHT, height: FLOAT_HEIGHT };
  const scale = FLOAT_HEIGHT / size.height;
  const make = (above) => vscode.window.createTextEditorDecorationType({
    before: {
      contentIconPath: vscode.Uri.file(full),
      textDecoration: `none; position:absolute; z-index:10; pointer-events:none;
        margin-left:3ch; margin-top:${above ? `calc(1.4em - ${FLOAT_HEIGHT}px)` : '0'};
        transform:scale(${scale}); transform-origin:0 0;`
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  floatTypes = { below: make(false), above: make(true) };
  return placeFloatingCat();
}

// Editors the floating cat may sit in: code files, not the Output panel and similar
const NOT_CODE = ['output', 'debug', 'vscode-scm', 'comment'];
const isCodeEditor = (e) => !!e && !NOT_CODE.includes(e.document.uri.scheme);

// Put the cat next to the cursor (or the top of the screen if the cursor is scrolled away).
// Returns false when there's no code editor open to float in.
function placeFloatingCat() {
  const active = vscode.window.activeTextEditor;
  const editor = isCodeEditor(active) ? active : vscode.window.visibleTextEditors.find(isCodeEditor);
  if (floatEditor && floatEditor !== editor) clearFloating(floatEditor);
  floatEditor = editor;
  if (!editor) return false;

  const visible = editor.visibleRanges[0];
  let pos = editor.selection.active;
  if (visible && !visible.contains(pos)) pos = visible.start;
  // In the bottom half of the screen the cat goes above the cursor so it doesn't get cut off
  const above = visible && pos.line > (visible.start.line + visible.end.line) / 2;
  editor.setDecorations(above ? floatTypes.above : floatTypes.below, [new vscode.Range(pos, pos)]);
  editor.setDecorations(above ? floatTypes.below : floatTypes.above, []);
  return true;
}

function clearFloating(editor) {
  editor.setDecorations(floatTypes.below, []);
  editor.setDecorations(floatTypes.above, []);
}

function stopFloating() {
  if (floatTypes) {
    floatTypes.below.dispose();
    floatTypes.above.dispose();
  }
  floatTypes = null;
  floatEditor = null;
}

// ---------- Reading picture files ----------

// First bytes of a picture file (that's where the format, size and "animated" flag live)
function readHeader(file) {
  try {
    const b = Buffer.alloc(30);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, b, 0, 30, 0);
    fs.closeSync(fd);
    return b;
  } catch { return null; }
}

const isExtendedWebp = (b) =>
  b && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 16) === 'WEBPVP8X';

// GIFs move; a WebP moves only if its header has the "animation" flag
function isAnimated(file) {
  if (/\.gif$/i.test(file)) return true;
  if (!/\.webp$/i.test(file)) return false;
  const b = readHeader(file);
  return isExtendedWebp(b) && (b[20] & 0x02) !== 0;
}

// Read a GIF's, PNG's or WebP's width and height from the start of the file
function imageSize(file) {
  const b = readHeader(file);
  if (!b) return null;
  if (b.toString('ascii', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (isExtendedWebp(b)) return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  return null;
}

// ---------- Commands for choosing ----------

// "Dancing Cat: Choose Where the Cat Appears"
async function choosePosition() {
  const current = showIn();
  const items = [
    { label: '$(layout-panel) Panel', detail: 'In the Dancing Cat tab (bottom panel, or wherever you moved it)', value: 'panel' },
    { label: '$(code) Floating in the editor (experimental)', detail: 'A small cat next to your cursor in the code file you have open', value: 'editor' },
    { label: '$(sparkle) Both', detail: 'Panel and floating in the editor', value: 'both' }
  ].map((item) => ({ ...item, description: item.value === current ? '✓ current' : '' }));

  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Where should the cat dance while Claude is thinking?' });
  if (!choice) return;
  await config().update('showIn', choice.value, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage('🐱 Saved! Run "Dancing Cat: Test Dance" to see it.');
}

// "Dancing Cat: Choose Cats Folder"
async function chooseCatsFolder() {
  const current = customFolder();
  const items = [
    { label: '$(folder-opened) Choose a folder with my own cats…', value: 'pick', description: current ? `✓ current: ${current}` : '' },
    { label: '$(discard) Use the built-in cats', value: 'reset', description: current ? '' : '✓ current' }
  ];
  const choice = await vscode.window.showQuickPick(items, { placeHolder: 'Which cats should dance?' });
  if (!choice) return;

  if (choice.value === 'reset') {
    await config().update('catsFolder', '', vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage('🐱 Using the built-in cats.');
    return;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use These Cats'
  });
  if (!picked) return;
  const dir = picked[0].fsPath;
  await config().update('catsFolder', dir, vscode.ConfigurationTarget.Global);
  const count = picturesIn(dir).length;
  vscode.window.showInformationMessage(count
    ? `🐱 Using ${count} cat${count === 1 ? '' : 's'} from ${dir}. Run "Dancing Cat: Test Dance" to see one!`
    : `No pictures in ${dir} yet. Add .gif or .webp files there; until then the built-in cats dance.`);
}

// ---------- Setup: the Claude Code hooks ----------

// On startup, offer to set up the hooks if they're missing (unless the user said "Don't Ask Again").
// Only the window you're using asks, and at most once a day ("Not Now" means "not today").
async function offerSetup(context) {
  let installed = false;
  try { installed = hooks.hooksInstalled(); } catch { /* unreadable settings: offer anyway */ }
  if (installed || context.globalState.get(DONT_ASK_SETUP)) return;

  if (!vscode.window.state.focused) {
    const sub = vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) { sub.dispose(); offerSetup(context); }
    });
    context.subscriptions.push(sub);
    return;
  }
  if (Date.now() - context.globalState.get(SETUP_ASKED_AT, 0) < ONE_DAY) return;
  await context.globalState.update(SETUP_ASKED_AT, Date.now());

  const choice = await vscode.window.showInformationMessage(
    'Dancing Cat: to know when Claude is thinking, the cat needs a few small hooks in Claude Code\'s settings (~/.claude/settings.json). A backup is made first.',
    'Set Up', 'Not Now', 'Don\'t Ask Again'
  );
  if (choice === 'Set Up') installHooksCommand();
  else if (choice === 'Don\'t Ask Again') context.globalState.update(DONT_ASK_SETUP, true);
}

// "Dancing Cat: Install Claude Code Hooks"
async function installHooksCommand() {
  let changed;
  try { changed = hooks.installHooks(); } catch (e) { return settingsProblem(e, 'install'); }
  if (!changed) {
    vscode.window.showInformationMessage('🐱 The Dancing Cat hooks are already set up.');
    return;
  }
  if (await nodeAvailable()) {
    vscode.window.showInformationMessage('🐱 Hooks installed (your previous settings are saved as settings.json.bak). Restart Claude Code, then send it a prompt!');
  } else {
    const choice = await vscode.window.showWarningMessage(
      '🐱 Hooks installed, but Node.js wasn\'t found. The hooks use Node.js to tell the cat when Claude is thinking. Install Node.js, then restart Claude Code.',
      'Get Node.js'
    );
    if (choice) vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org'));
  }
}

// "Dancing Cat: Remove Claude Code Hooks"
async function removeHooksCommand() {
  let changed;
  try { changed = hooks.removeHooks(); } catch (e) { return settingsProblem(e, 'remove'); }
  stopDancing();
  vscode.window.showInformationMessage(changed
    ? '🐱 Dancing Cat hooks removed from Claude Code\'s settings (previous settings saved as settings.json.bak).'
    : 'No Dancing Cat hooks were found in Claude Code\'s settings.');
}

async function settingsProblem(err, action) {
  const reason = err instanceof hooks.SettingsError ? err.message : `unexpected error (${err.message})`;
  const choice = await vscode.window.showErrorMessage(
    `Dancing Cat couldn't ${action} the hooks: ${reason}. Your Claude settings were not changed.`,
    'Open Settings File'
  );
  if (choice) vscode.window.showTextDocument(vscode.Uri.file(hooks.SETTINGS_FILE));
}

function nodeAvailable() {
  return new Promise((resolve) => {
    exec('node --version', { timeout: 5000, windowsHide: true }, (err) => resolve(!err));
  });
}

// ---------- The panel ----------

function render() {
  if (!view) return; // not visible yet; resolveWebviewView will render when it is
  const webview = view.webview;
  const roots = [mediaDir, path.dirname(sleepFile), customFolder()].filter(Boolean);
  webview.options = { enableScripts: false, localResourceRoots: roots.map((d) => vscode.Uri.file(d)) };
  const src = catPath ? webview.asWebviewUri(vscode.Uri.file(catPath)).toString() : '';
  webview.html = pageHtml(webview.cspSource, src);
}

const baseCss = `
  html, body { height:100%; }
  body { display:flex; flex-direction:column; align-items:center; justify-content:center;
         margin:0; padding:8px; box-sizing:border-box; overflow:hidden;
         font-family:var(--vscode-font-family); color:var(--vscode-foreground); }
  .cat { max-width:100%; max-height:calc(100vh - 56px); object-fit:contain; border-radius:12px; }
  .emoji { font-size:64px; line-height:1; }
  p { opacity:.8; margin:8px 0 0; font-size:12px; text-align:center; }
  .notes { position:absolute; bottom:8px; font-size:28px; animation: float 2s linear infinite; }
  @keyframes float { from { transform: translateY(0); opacity:1 } to { transform: translateY(-120px); opacity:0 } }
  @keyframes wiggle { 0%,100% { transform: rotate(-15deg) } 50% { transform: rotate(15deg) } }
  @keyframes spin { to { transform: rotate(360deg) } }
  @keyframes bounce { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-30px) } }
  @keyframes moonwalk { 0%,100% { transform: translateX(-80px) scaleX(1) } 49% { transform: translateX(80px) scaleX(1) } 50% { transform: translateX(80px) scaleX(-1) } 99% { transform: translateX(-80px) scaleX(-1) } }
  @keyframes disco { 0% { transform: scale(1) rotate(0); filter:hue-rotate(0) } 50% { transform: scale(1.15) rotate(20deg); filter:hue-rotate(180deg) } 100% { transform: scale(1) rotate(0); filter:hue-rotate(360deg) } }
`;

function pageHtml(cspSource, src) {
  const speed = { wiggle: '.4s', spin: '1s', bounce: '.5s', moonwalk: '2s', disco: '.8s' }[dance];
  const animation = dance ? `.cat { animation: ${dance} ${speed} ease-in-out infinite; }` : '';
  const notes = thinking
    ? `<span class="notes" style="left:15%">♪</span>
       <span class="notes" style="left:80%; animation-delay:1s">♫</span>`
    : '';
  const picture = src
    ? `<img class="cat" src="${src}" alt="${thinking ? 'dancing' : 'napping'} cat">`
    : `<div class="emoji">${thinking ? '😸' : '😴'}</div>`;
  return `<!DOCTYPE html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'unsafe-inline';">
    <style>${baseCss} ${animation}</style>
  </head><body class="${thinking ? 'dancing' : 'napping'}">
    ${notes}
    ${picture}
    <p>${message}</p>
  </body></html>`;
}

function deactivate() {
  clearInterval(statusTimer);
  stopFloating();
}

module.exports = { activate, deactivate };
