<p align="center"><img src="images/logo.png" width="128" alt="Dancing Cat logo: a pixel-art white cat vibing"></p>

# Dancing Cat for Claude Code 🐱💃

A random cat dances in VS Code while Claude Code is thinking, and naps when it's done.

![Demo: the cat naps in the Dancing Cat panel; after a prompt is sent to Claude Code, it jumps into the editor and dances next to the cursor while paw prints show in the panel](images/demo.gif)

> Not affiliated with or endorsed by Anthropic. "Claude" and "Claude Code" are trademarks of Anthropic.

## Features

- 🕺 **Dances while Claude works.** Every prompt picks a random cat.
- 😴 **Naps when Claude is done.**
- 📍 **Your choice of spot.** In a panel, floating next to your cursor (experimental), or both.
- 🖼️ **Bring your own cats.** Use any folder of animated GIFs.
- ✋ **One click to stop.** Click the dancing cat in the status bar.

## Requirements

- VS Code 1.80 or newer
- Claude Code (VS Code extension or terminal)
- [Node.js](https://nodejs.org) on your `PATH`

## Getting started

1. Install **Dancing Cat for Claude Code** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=fatemeh-mokhtari.claude-dancing-cat), or download the `.vsix` from [GitHub Releases](https://github.com/Fateme-mokhtari/claude-dancing-cat/releases).
2. Click **Set Up** when prompted, or in the **Dancing Cat** panel.
3. Restart Claude Code and send a prompt.

To preview a dance at any time, run **Dancing Cat: Show Me a Dance**.

## Where the cat appears

Run **Dancing Cat: Choose Where the Cat Appears**:

| Option | Description |
|---|---|
| **Panel** (default) | The **Dancing Cat** tab in the bottom panel. You can drag it to a sidebar or next to the Claude chat. |
| **Floating in the editor** *(experimental)* | A small cat next to your cursor that doesn't block clicks. Falls back to the panel when no file is open. |
| **Both** | Panel and floating. |

## Use your own cats

Run **Dancing Cat: Choose Cats Folder** and pick a folder of animated `.gif` or `.webp` files. A random one dances each time Claude starts thinking; still images are ignored. Choose **Use the built-in cats** to switch back.

Cats with a transparent background, such as GIPHY stickers, look best.

## Commands

| Command | Description |
|---|---|
| Dancing Cat: Show Me a Dance | Shows a dancing cat for 5 seconds |
| Dancing Cat: Stop Dancing | Puts the cat back to sleep |
| Dancing Cat: Choose Where the Cat Appears | Panel, floating, or both |
| Dancing Cat: Choose Cats Folder | Your own cats or the built-in ones |
| Dancing Cat: Install Claude Code Hooks | Connects the cat to Claude Code |
| Dancing Cat: Remove Claude Code Hooks | Disconnects it |

## Settings

| Setting | Default | Description |
|---|---|---|
| `dancingCat.showIn` | `panel` | `panel`, `editor` (floating, experimental) or `both` |
| `dancingCat.catsFolder` | *(empty)* | Folder with your own cats. Leave empty for the built-in cats. Relative paths start from your home folder. |

## What it changes on your computer

- **Claude Code settings:** adds three [hooks](https://code.claude.com/docs/en/hooks) to `~/.claude/settings.json`. They run when you send a prompt, when Claude finishes, and when it closes. The previous file is backed up to `settings.json.bak` before every change, and your original is kept as `settings.json.before-dancing-cat`. If the file can't be read, nothing is changed.
- **One state file:** the hooks write `thinking` or `idle` to `~/.claude/dancing-cat.state`, which the extension watches.
- **No network access or tracking.**

<details>
<summary>Install the hooks manually</summary>

Add this to `~/.claude/settings.json`, merged with any hooks you already have:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command",
      "command": "node -e \"require('fs').writeFileSync(require('path').join(require('os').homedir(),'.claude','dancing-cat.state'),'thinking')\"" }] }],
    "Stop": [{ "hooks": [{ "type": "command",
      "command": "node -e \"require('fs').writeFileSync(require('path').join(require('os').homedir(),'.claude','dancing-cat.state'),'idle')\"" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command",
      "command": "node -e \"require('fs').writeFileSync(require('path').join(require('os').homedir(),'.claude','dancing-cat.state'),'idle')\"" }] }]
  }
}
```
</details>

## Uninstalling

Run **Dancing Cat: Remove Claude Code Hooks**. Uninstalling the extension also removes the hooks and the state file the next time VS Code restarts.

## Known limitations

- **Esc doesn't stop the dance.** Claude Code doesn't run its `Stop` hook when interrupted. Click the status bar cat or run **Dancing Cat: Stop Dancing**.
- **One cat for all sessions.** Every Claude Code session on your computer controls the cat, so it naps as soon as any session finishes.
- **Hooks are shared between editors.** Uninstalling from one editor (for example VS Code or Cursor) removes the hooks for all of them. Run **Install Claude Code Hooks** again in the others.

## Contributing

Found a bug or have an idea? Open an [issue](https://github.com/Fateme-mokhtari/claude-dancing-cat/issues). To build or change the extension, see [DEVELOPMENT.md](DEVELOPMENT.md).

## License

[MIT](LICENSE) © Fatemeh Mokhtari
