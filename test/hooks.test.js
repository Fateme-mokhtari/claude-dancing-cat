// Tests for hooks.js (adding/removing the Claude Code hooks) and uninstall.js.
// Runs against a temporary fake home folder, so your real ~/.claude is never touched.
// Run with: npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execSync, execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dancing-cat-home-'));
process.env.HOME = fakeHome;        // macOS / Linux
process.env.USERPROFILE = fakeHome; // Windows
const hooks = require(path.join(root, 'hooks.js'));
assert.ok(hooks.SETTINGS_FILE.startsWith(fakeHome), 'tests must use the fake home folder');

const file = hooks.SETTINGS_FILE;
const write = (o) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof o === 'string' ? o : JSON.stringify(o, null, 2));
};
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
let passed = 0;
let firstSettings = null;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };

test('no settings file: install creates it with 3 hooks', () => {
  assert.strictEqual(hooks.installHooks(), true);
  assert.deepStrictEqual(Object.keys(read().hooks).sort(), ['SessionEnd', 'Stop', 'UserPromptSubmit']);
  assert.ok(hooks.hooksInstalled());
});

test('install twice: no duplicates, reports no change', () => {
  assert.strictEqual(hooks.installHooks(), false);
  assert.strictEqual(read().hooks.Stop.length, 1);
});

test('keeps other settings and other hooks; makes backups', () => {
  const mine = {
    model: 'opus',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }]
    }
  };
  write(mine);
  assert.strictEqual(hooks.installHooks(), true);
  const s = read();
  assert.strictEqual(s.model, 'opus');
  assert.strictEqual(s.hooks.Stop.length, 2);
  assert.strictEqual(s.hooks.Stop[0].hooks[0].command, 'echo bye');
  assert.deepStrictEqual(s.hooks.PreToolUse, mine.hooks.PreToolUse);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file + '.bak', 'utf8')), mine);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(hooks.ORIGINAL_BACKUP, 'utf8')), mine, 'first-ever backup made');
  firstSettings = mine;
});

test('old install (2 hooks) gets upgraded with SessionEnd only', () => {
  const entry = (state) => [{ hooks: [{ type: 'command', command: hooks.hookCommand(state) }] }];
  write({ hooks: { UserPromptSubmit: entry('thinking'), Stop: entry('idle') } });
  assert.strictEqual(hooks.hooksInstalled(), false);
  assert.strictEqual(hooks.installHooks(), true);
  const s = read();
  assert.strictEqual(s.hooks.UserPromptSubmit.length, 1);
  assert.strictEqual(s.hooks.Stop.length, 1);
  assert.strictEqual(s.hooks.SessionEnd.length, 1);
});

test('remove: takes out only ours, keeps the rest', () => {
  write({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } });
  hooks.installHooks();
  const s0 = read(); // put one of ours inside a group that also has someone else's hook
  s0.hooks.UserPromptSubmit[0].hooks.unshift({ type: 'command', command: 'echo hi' });
  write(s0);
  assert.strictEqual(hooks.removeHooks(), true);
  const s = read();
  assert.strictEqual(s.model, 'opus');
  assert.deepStrictEqual(s.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo bye' }] }]);
  assert.deepStrictEqual(s.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: 'echo hi' }] }]);
  assert.strictEqual(s.hooks.SessionEnd, undefined);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('dancing-cat.state'));
});

test('remove when only ours: the hooks key disappears', () => {
  write({ model: 'opus' });
  hooks.installHooks();
  hooks.removeHooks();
  assert.deepStrictEqual(read(), { model: 'opus' });
  assert.strictEqual(hooks.removeHooks(), false);
});

test('invalid JSON: install and remove refuse and leave the file untouched', () => {
  const bad = '{\n  // my comment\n  "model": "opus"\n}\n';
  write(bad);
  assert.throws(() => hooks.installHooks(), hooks.SettingsError);
  assert.throws(() => hooks.removeHooks(), hooks.SettingsError);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), bad);
});

test('unexpected shapes are refused, not overwritten', () => {
  for (const bad of ['[1,2]', '"text"', '{"hooks": []}', '{"hooks": {"Stop": {}}}']) {
    write(bad);
    assert.throws(() => hooks.installHooks(), hooks.SettingsError, bad);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), bad);
  }
});

test('an empty settings file counts as empty settings', () => {
  write('');
  assert.strictEqual(hooks.installHooks(), true);
  assert.ok(hooks.hooksInstalled());
});

test('no temporary file is left behind', () => {
  assert.ok(!fs.existsSync(file + '.dancing-cat.tmp'));
});

test('the hook command really writes the state file', () => {
  execSync(hooks.hookCommand('thinking'), { env: process.env });
  assert.strictEqual(fs.readFileSync(hooks.STATE_FILE, 'utf8'), 'thinking');
});

test('uninstall.js removes the hooks and the state file', () => {
  write({ model: 'opus' });
  hooks.installHooks();
  fs.writeFileSync(hooks.STATE_FILE, 'idle');
  execFileSync(process.execPath, [path.join(root, 'uninstall.js')], { env: process.env });
  assert.deepStrictEqual(read(), { model: 'opus' });
  assert.ok(!fs.existsSync(hooks.STATE_FILE));
});

test('the first-ever backup is never overwritten, and survives uninstall', () => {
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(hooks.ORIGINAL_BACKUP, 'utf8')), firstSettings);
});

fs.rmSync(fakeHome, { recursive: true, force: true });
console.log(`\nhooks: all ${passed} tests passed\n`);
