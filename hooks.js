// Adds and removes the Dancing Cat hooks in Claude Code's settings (~/.claude/settings.json).
// Plain Node.js (no VS Code API), so uninstall.js can use it too.
//
// Safety rules:
// - If the settings file can't be read as JSON, nothing is changed (a SettingsError is thrown).
// - The very first time, the file is copied to settings.json.before-dancing-cat (never overwritten).
// - Before every change, the old file is also copied to settings.json.bak.
// - Only hooks that mention "dancing-cat.state" are ever added or removed.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const ORIGINAL_BACKUP = SETTINGS_FILE + '.before-dancing-cat';
const STATE_FILE = path.join(CLAUDE_DIR, 'dancing-cat.state');
const MARK = 'dancing-cat.state'; // every hook we add mentions the state file

// Claude Code event -> what we write to the state file
const EVENTS = {
  UserPromptSubmit: 'thinking', // you sent a prompt
  Stop: 'idle',                 // Claude finished answering
  SessionEnd: 'idle'            // Claude was closed
};

// Uses Node so the same command works in bash, cmd and PowerShell
const hookCommand = (state) =>
  `node -e "require('fs').writeFileSync(require('path').join(require('os').homedir(),'.claude','dancing-cat.state'),'${state}')"`;

class SettingsError extends Error {}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isOurs = (x) => JSON.stringify(x).includes(MARK);

function readSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return {};
  const text = fs.readFileSync(SETTINGS_FILE, 'utf8');
  if (!text.trim()) return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new SettingsError(`~/.claude/settings.json isn't valid JSON (${e.message})`);
  }
  if (!isObject(data)) throw new SettingsError("~/.claude/settings.json doesn't contain a settings object");
  return data;
}

function writeSettings(data) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (fs.existsSync(SETTINGS_FILE)) {
    // one-time copy of the settings from before Dancing Cat ever changed them
    if (!fs.existsSync(ORIGINAL_BACKUP)) fs.copyFileSync(SETTINGS_FILE, ORIGINAL_BACKUP);
    fs.copyFileSync(SETTINGS_FILE, SETTINGS_FILE + '.bak');
  }
  // write to a temporary file first, so a crash can't leave a half-written settings file
  const tmp = SETTINGS_FILE + '.dancing-cat.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS_FILE);
}

function hooksInstalled(settings = readSettings()) {
  const hooks = settings.hooks;
  return isObject(hooks) && Object.keys(EVENTS).every((e) => Array.isArray(hooks[e]) && hooks[e].some(isOurs));
}

// Adds any missing Dancing Cat hooks. Returns true if the settings file was changed.
function installHooks() {
  const settings = readSettings();
  if (hooksInstalled(settings)) return false;
  if (settings.hooks !== undefined && !isObject(settings.hooks)) {
    throw new SettingsError('"hooks" in ~/.claude/settings.json isn\'t an object');
  }
  const hooks = settings.hooks || (settings.hooks = {});
  for (const [event, state] of Object.entries(EVENTS)) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) {
      throw new SettingsError(`"hooks.${event}" in ~/.claude/settings.json isn't a list`);
    }
    hooks[event] = hooks[event] || [];
    if (!hooks[event].some(isOurs)) {
      hooks[event].push({ hooks: [{ type: 'command', command: hookCommand(state) }] });
    }
  }
  writeSettings(settings);
  return true;
}

// Removes only the Dancing Cat hooks. Returns true if the settings file was changed.
function removeHooks() {
  const settings = readSettings();
  const hooks = settings.hooks;
  if (!isObject(hooks) || !isOurs(hooks)) return false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event]) || !hooks[event].some(isOurs)) continue;
    hooks[event] = hooks[event].flatMap((group) => {
      if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(isOurs)) return [group];
      const others = group.hooks.filter((h) => !isOurs(h));
      return others.length ? [{ ...group, hooks: others }] : [];
    });
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  writeSettings(settings);
  return true;
}

module.exports = {
  CLAUDE_DIR, SETTINGS_FILE, ORIGINAL_BACKUP, STATE_FILE, EVENTS, SettingsError,
  readSettings, hooksInstalled, installHooks, removeHooks, hookCommand
};
