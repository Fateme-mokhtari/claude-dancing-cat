# Changelog

## 0.1.4

- A new dancing cat.
- The black cat no longer has text written on it.

## 0.1.3

- Now also on [Open VSX](https://open-vsx.org/extension/fatemeh-mokhtari/claude-dancing-cat), for Cursor and other VS Code-based editors.
- Shorter, clearer README.

## 0.1.2

- If Claude Code isn't set up yet, the panel now says so and shows a **Set Up** button, instead of a cat that never wakes up.

## 0.1.1

- Only moving cats dance now: your cats folder uses animated `.gif` and `.webp` files. Still pictures (`.png`, `.jpg`, still `.webp`) are skipped. If your folder only has still pictures, the built-in cats dance instead.
- Fixes very large cats floating in the editor: every cat that can dance is now scaled to the right size.

## 0.1.0

First public release.

- A random cat dances while Claude Code is thinking; a sleeping cat naps when it's done.
- Show the cat in a panel tab, floating next to your cursor (experimental), or both.
- Use your own folder of cat GIFs / animated WebPs (`dancingCat.catsFolder`, or **Choose Cats Folder**).
- Click the status bar cat (or run **Stop Dancing**) to stop it, e.g. after pressing Esc in Claude.
- Asks to set up the Claude Code hooks on first start (once, in the window you're using).
- Never changes a Claude settings file it can't read; keeps a backup before every change, plus a one-time copy of your original settings.
- **Remove Claude Code Hooks** command, and automatic cleanup when the extension is uninstalled.
