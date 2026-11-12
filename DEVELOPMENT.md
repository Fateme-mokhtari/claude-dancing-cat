# Developing Dancing Cat

Notes for working on the extension itself. This file is in the GitHub repo but not in the published extension.

## Files

| File | What it is |
|---|---|
| `package.json` | Manifest: name, commands, settings, the panel tab |
| `extension.js` | The extension: watches the state file and shows the cat |
| `hooks.js` | Adds/removes the Claude Code hooks in `~/.claude/settings.json` (plain Node.js, no VS Code API) |
| `uninstall.js` | Runs when the extension is uninstalled; removes the hooks |
| `media/` | Built-in dancing cats (animated WebP) |
| `resources/` | Panel icon (`cat.svg`), Marketplace icon (`icon.png`), napping cat (`sleeping-cat.webp`) |
| `images/` | Pictures for the README (not packaged) |
| `test/` | Tests (not packaged) |
| `.github/workflows/test.yml` | Runs the tests on Windows, macOS and Linux on every push |
| `.github/workflows/publish.yml` | Publishes a new version when it's merged into `main` (see below) |

There are no npm dependencies: you only need Node.js.

## How it works

1. `hooks.js` adds three [Claude Code hooks](https://code.claude.com/docs/en/hooks) to `~/.claude/settings.json`. They write `thinking` (on `UserPromptSubmit`) or `idle` (on `Stop` and `SessionEnd`) to `~/.claude/dancing-cat.state`.
2. `extension.js` checks that file every 300 ms and shows a dancing or napping cat in a webview panel and/or as an editor decoration.

## Run the tests

```
npm test
```

The tests use a temporary fake home folder, so your real `~/.claude` is never touched. `test/extension.test.js` runs the extension against a small fake `vscode` module.

## Try it without installing

1. Open this folder in VS Code and press **F5** (pick "VS Code Extension Development" if asked).
2. In the new window, run **Dancing Cat: Show Me a Dance** from the Command Palette.

## Install it on your own computer

```
npx @vscode/vsce package
code --install-extension claude-dancing-cat-0.1.0.vsix --force
```

Then run **Developer: Reload Window**. Use the version from `package.json` in the file name.

## Release a new version

1. In a pull request, update `version` in `package.json` and add a section for it to `CHANGELOG.md`.
2. Merge it. The **Publish** workflow then tests the extension, publishes it to the VS Code Marketplace and Open VSX, and creates the GitHub Release with the `.vsix`.

Merges that don't change the version publish nothing. If publishing fails, fix the cause and click **Run workflow** on the Publish workflow in the **Actions** tab; stores that already have the version are skipped.

Both stores trust the workflow through **Trusted Publishing**, so no tokens are stored in GitHub. It's set up once per store, with owner `Fateme-mokhtari`, repository `claude-dancing-cat` and workflow `publish.yml`:

- VS Code Marketplace: https://marketplace.visualstudio.com/manage/publishers/fatemeh-mokhtari → **Trusted Publishing**
- Open VSX: https://open-vsx.org → **Settings → Trusted Publishers**
