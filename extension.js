const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const hooks = require('./hooks');

const STATE_FILE = hooks.STATE_FILE;  // the hooks write "thinking" / "idle" here
const VIEW_ID = 'dancingCat.view';    // the "Dancing Cat" tab in the bottom panel (see package.json)
const FLOAT_HEIGHT = 180;             // size (px) of the cat floating in the code editor
const CAT_FILE = /\.(gif|webp)$/i;   // only moving cats dance: GIFs and animated WebPs
const DONT_ASK_SETUP = 'dancingCat.dontAskSetup';
const SETUP_ASKED_AT = 'dancingCat.setupAskedAt';
const ONE_DAY = 24 * 60 * 60 * 1000;

const MESSAGES = [
  'Claude is thinking… the cat is dancing',
  'Busting moves while the tokens flow',
  'Thinking hard, dancing harder',
  'Cat.exe is grooving',
  'Hold on, it’s a long song'
];
const NAP_MESSAGE = 'Cat is napping… send Claude a prompt to wake it up';
// shown in the panel while the cat is away, floating in your editor
const AWAY_MESSAGES = [
  'The cat ran off to dance in your code!',
  'Shh… the cat sneaked into your code 👀',
  'Gone dancing. Back when Claude is done.',
  'Out on the dance floor (your editor)'
];

let view = null;        // the panel's webview (null until VS Code first shows it)
let mediaDir = null;    // built-in cats
let sleepFile = null;   // resources/sleeping-cat.webp, shown while Claude is idle
let thinking = false;   // is Claude working right now?
let catPath = null;     // full path of the picture currently shown
let message = NAP_MESSAGE;
let awayMessage = AWAY_MESSAGES[0];
let statusItem = null;
let statusTimer = null;
let floatTypes = null;  // { below, above } decorations for the cat floating in the editor
let floatEditor = null; // the editor the floating cat is in
let floatingOnly = false; // "editor" mode and the cat is floating: the panel must not show a second cat
let lastEditor = null;  // the code editor you used last (no editor is "active" while you type to Claude)
let setUp = false;      // are the Claude Code hooks installed? Until they are, the panel offers "Set Up"

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

  // The floating cat follows your cursor, the editor you switch to, and scrolling.
  // In "editor" mode, if no code file is visible anymore the panel takes over (and back again).
  const follow = () => {
    if (!floatTypes) return;
    const placed = placeFloatingCat();
    if (showIn() === 'editor' && placed !== floatingOnly) {
      floatingOnly = placed;
      render();
      if (!placed) reveal();
    }
  };
  if (isCodeEditor(vscode.window.activeTextEditor)) lastEditor = vscode.window.activeTextEditor;
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (isCodeEditor(e)) lastEditor = e;
      follow();
    }),
    vscode.window.onDidChangeTextEditorSelection(follow),
    vscode.window.onDidChangeTextEditorVisibleRanges(follow),
    { dispose: stopFloating }
  );

  // Always start napping (an old "thinking" left over from a closed Claude shouldn't make it dance)
  setUp = isSetUp();
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

  // Notice when the hooks are installed or removed somewhere else
  // (another VS Code window, by hand, or the uninstall cleanup)
  const settingsChanged = () => refreshSetUp();
  fs.watchFile(hooks.SETTINGS_FILE, { interval: 1000 }, settingsChanged);
  context.subscriptions.push({ dispose: () => fs.unwatchFile(hooks.SETTINGS_FILE, settingsChanged) });

  context.subscriptions.push(
    vscode.commands.registerCommand('dancingCat.showDance', () => {
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

// The moving cats (GIFs and animated WebPs) in a folder. Still pictures are skipped.
function catsIn(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => CAT_FILE.test(f)).map((f) => path.join(dir, f)).filter(isAnimated);
  } catch { return []; }
}

// Full paths of the cats to choose from: the user's folder if it has any, otherwise the built-in ones
function listCats() {
  const dir = customFolder();
  const mine = dir ? catsIn(dir) : [];
  return mine.length ? mine : catsIn(mediaDir);
}

// ---------- Dancing and napping ----------

function startDancing() {
  const cats = listCats();
  catPath = cats.length ? pick(cats) : null;
  message = pick(MESSAGES);
  awayMessage = pick(AWAY_MESSAGES);
  thinking = true;

  const where = showIn();
  const floating = where !== 'panel' && catPath && startFloating(catPath);
  // In "editor" mode the cat dances only in the editor. The panel is the backup
  // when there's no code file open to float in.
  floatingOnly = where === 'editor' && !!floating;
  render();
  if (!floatingOnly) reveal();

  // little animated cat in the status bar too
  const frames = ['$(loading~spin) Cat is dancing ♪', '$(loading~spin) Cat is dancing ♫'];
  let i = 0;
  statusItem.text = frames[0];
  statusItem.show();
  clearInterval(statusTimer);
  statusTimer = setInterval(() => { statusItem.text = frames[i++ % frames.length]; }, 300);
}

// Claude is done: the cat stays in the panel and naps.
// Uses resources/sleeping-cat.webp, or else a 😴 emoji.
function napping() {
  thinking = false;
  floatingOnly = false;
  stopFloating();
  catPath = fs.existsSync(sleepFile) ? sleepFile : null;
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
// Real files (on disk, new unsaved ones, remote). A diff view also contains an "old version"
// editor (scheme "git") that is hidden in the inline diff layout, so prefer real files.
const REAL_FILE = ['file', 'untitled', 'vscode-remote', 'vscode-userdata'];
const isCodeEditor = (e) => !!e && !NOT_CODE.includes(e.document.uri.scheme);
const isRealFile = (e) => isCodeEditor(e) && REAL_FILE.includes(e.document.uri.scheme);

// The code editor to float in: the active one, or (while you type to Claude, when no editor is
// active) the one you used last, or else a visible real file.
function pickEditor() {
  const active = vscode.window.activeTextEditor;
  if (isCodeEditor(active)) return active;
  const visible = vscode.window.visibleTextEditors;
  if (lastEditor && visible.includes(lastEditor)) return lastEditor;
  return visible.find(isRealFile) || visible.find(isCodeEditor);
}

// Put the cat next to the cursor (or the top of the screen if the cursor is scrolled away).
// Returns false when there's no code editor open to float in.
function placeFloatingCat() {
  const editor = pickEditor();
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

// Read a GIF's or animated WebP's width and height from the start of the file
function imageSize(file) {
  const b = readHeader(file);
  if (!b) return null;
  if (b.toString('ascii', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
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
  vscode.window.showInformationMessage('🐱 Saved! Run "Dancing Cat: Show Me a Dance" to see it.');
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
  const count = catsIn(dir).length;
  vscode.window.showInformationMessage(count
    ? `🐱 Using ${count} cat${count === 1 ? '' : 's'} from ${dir}. Run "Dancing Cat: Show Me a Dance" to see one!`
    : `No moving cats in ${dir} yet. Add animated .gif or .webp files there (still pictures are skipped); until then the built-in cats dance.`);
}

// ---------- Setup: the Claude Code hooks ----------

// Are the hooks in Claude Code's settings? An unreadable settings file counts as "no".
function isSetUp() {
  try { return hooks.hooksInstalled(); } catch { return false; }
}

// Check the hooks again, and redraw the panel if that changed
function refreshSetUp() {
  const now = isSetUp();
  if (now === setUp) return;
  setUp = now;
  render();
}

// On startup, offer to set up the hooks if they're missing (unless the user said "Don't Ask Again").
// Only the window you're using asks, and at most once a day ("Not Now" means "not today").
// Whatever they answer, the panel keeps a "Set Up" button until the hooks are installed.
async function offerSetup(context) {
  if (isSetUp() || context.globalState.get(DONT_ASK_SETUP)) return;

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
  refreshSetUp();
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
  refreshSetUp();
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
  // No scripts. Command links are on so the "Set Up" button can run the install command.
  webview.options = { enableScripts: false, enableCommandUris: true, localResourceRoots: roots.map((d) => vscode.Uri.file(d)) };
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
  /* the "Set Up" link, drawn like a VS Code button */
  .button { margin-top:10px; padding:4px 14px; border-radius:2px; font-size:13px; text-decoration:none;
            background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
  .button:hover { background:var(--vscode-button-hoverBackground); }
  .button:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:2px; }
  .note { font-size:11px; }
  .needs-setup .cat { max-height:calc(100vh - 130px); } /* leave room for the button and note */
`;

// One paw print: a big pad and four toes (toes point up; the CSS turns it to walk right)
const PAW_SHAPE = '<g fill="currentColor"><ellipse cx="12" cy="16" rx="5" ry="4.2"/>'
  + '<ellipse cx="5.6" cy="9.6" rx="2.2" ry="2.8"/><ellipse cx="9.6" cy="5.4" rx="2.2" ry="2.8"/>'
  + '<ellipse cx="14.4" cy="5.4" rx="2.2" ry="2.8"/><ellipse cx="18.4" cy="9.6" rx="2.2" ry="2.8"/></g>';

// Paw prints that appear one after another, heading right, then fade (no scripts, just CSS)
const awayCss = `
  .trail { position:relative; width:210px; height:64px; color:var(--vscode-foreground); }
  .paw { position:absolute; opacity:0; animation: paw 2.8s ease-out infinite; }
  @keyframes paw {
    0%   { opacity:0;  transform: rotate(90deg) scale(.5) }
    12%  { opacity:.8; transform: rotate(90deg) scale(1) }
    60%  { opacity:.8; transform: rotate(90deg) scale(1) }
    100% { opacity:0;  transform: rotate(90deg) scale(1) }
  }
  @media (prefers-reduced-motion: reduce) {
    .paw { animation:none; opacity:.7; transform: rotate(90deg); }
  }
`;

function pageHtml(cspSource, src) {
  const notes = thinking
    ? `<span class="notes" style="left:15%">♪</span>
       <span class="notes" style="left:80%; animation-delay:1s">♫</span>`
    : '';
  if (thinking && floatingOnly) {
    // The cat is floating in the editor: a trail of paw prints runs off the panel.
    // Drawn as a small shape in the theme's text colour, so it shows on dark and light themes.
    const paws = [[0, 34], [44, 12], [88, 34], [132, 12], [176, 34]]
      .map(([x, y], i) => `<svg class="paw" style="left:${x}px; top:${y}px; animation-delay:${i * 0.35}s" viewBox="0 0 24 24" width="24" height="24">${PAW_SHAPE}</svg>`)
      .join('');
    return `<!DOCTYPE html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
      <style>${baseCss} ${awayCss}</style>
    </head><body class="dancing away">
      <div class="trail" aria-hidden="true">${paws}</div>
      <p>${awayMessage}</p>
    </body></html>`;
  }
  const picture = src
    ? `<img class="cat" src="${src}" alt="${thinking ? 'dancing' : 'napping'} cat">`
    : `<div class="emoji">${thinking ? '😸' : '😴'}</div>`;
  // Without the hooks the cat never hears Claude, so "send a prompt to wake it up" wouldn't work:
  // say what's missing and offer the fix instead
  const needsSetup = !thinking && !setUp;
  const text = needsSetup
    ? `<p>The cat can't hear Claude yet.</p>
       <a class="button" href="command:dancingCat.installHooks">Set Up</a>
       <p class="note">Adds 3 small hooks to Claude Code's settings. A backup is made first.</p>`
    : `<p>${message}</p>`;
  return `<!DOCTYPE html><html><head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'unsafe-inline';">
    <style>${baseCss}</style>
  </head><body class="${thinking ? 'dancing' : 'napping'}${needsSetup ? ' needs-setup' : ''}">
    ${notes}
    ${picture}
    ${text}
  </body></html>`;
}

function deactivate() {
  clearInterval(statusTimer);
  stopFloating();
}

module.exports = { activate, deactivate };
