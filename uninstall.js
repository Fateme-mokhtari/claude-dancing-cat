// VS Code runs this once when the extension is uninstalled ("vscode:uninstall" in package.json).
// It removes the Dancing Cat hooks from Claude Code's settings and deletes the state file.
const fs = require('fs');
const hooks = require('./hooks');

try { hooks.removeHooks(); } catch { /* settings unreadable: leave them untouched */ }
try { fs.unlinkSync(hooks.STATE_FILE); } catch { /* already gone */ }
