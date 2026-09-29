# TyranoPatcher

Launches a TyranoScript visual novel with these improvements, without modifying any game file:

- **Transition skip**: left click (or Enter) while the game is busy with a fade, a character
  appearing/changing/leaving, a background crossfade, `[mask]`, `[quake]`, `[trans]`/`[wt]`,
  `[anim]`/`[wa]` or a `[wait]` finishes it instantly and moves on to the next thing. The same click
  does not also skip the next line of text.
- **Fast skip**: the game's own skip mode no longer plays out waits and effects. Every engine
  wait/animation is collapsed to ~0ms, one-shot sound effects are not played while skipping, and
  save writes of system variables are batched.
- **Rollback**: **Backspace**, **PageUp** or the mouse's **back** side button returns to the
  previous line of text, with its background, characters, text, variables, backlog and music
  restored. Press it repeatedly to keep going back (up to 300 lines). Pressed during a transition
  or while a line is still typing, it returns to the last complete line. Clicking afterwards plays
  on normally, including any choices you make differently.

## Usage

1. Copy `TyranoPatcher.exe` into the game's folder (next to the game's `.exe`).
2. Run `TyranoPatcher.exe` instead of the game.

You can also drag the game's `.exe` onto `TyranoPatcher.exe`. A short
"TyranoPatcher: ... active" note appears in the top-left corner when the patch is applied.

Optional settings: copy `TyranoPatcher.ini.example` to `TyranoPatcher.ini` next to the exe.

## How it works

TyranoScript games for Windows are Chromium apps (Electron, or NW.js for older/TyranoBuilder
builds). `TyranoPatcher.exe` starts the game with Chromium's `--remote-debugging-port` on a random
local port and injects `src/patch.js` into the game page through the DevTools protocol. It stays
running in the background (no window) and re-applies the patch whenever the game reloads its page,
e.g. on "back to title". It exits when the game closes. A log is written to
`%TEMP%\TyranoPatcher.log`.

`patch.js` hooks into the engine (`TYRANO.kag`):

- Timers created while tags execute are tracked. A click fires the pending ones early; during skip
  they are created with no delay (via `MessageChannel`, avoiding the browser's 4ms clamp).
- Running animations are finished: CSS animations/transitions through the Web Animations API
  (`--enable-blink-features=WebAnimationsAPI` makes this available on Electron 7), with a fallback
  that shortens CSS animations on older runtimes; jQuery and jQuery UI animations are jumped to
  their end with their queued callbacks intact; anime.js instances and `[quake2]` are completed.
- Rollback: when the player advances from a line (the engine leaves an `[l]`/`[p]` it was waiting
  on), a snapshot of the same data the engine's own save contains (layers, `stat`, scenario
  position) plus the backlog is kept in memory. The hotkey cancels everything still in flight
  (tracked timers, the typing of the current line, animations) while blocking the engine from
  advancing, then restores the newest snapshot through the engine's own `loadGameData`. Music is
  left playing when it did not change. Loading a save clears the history; returning from
  `[sleepgame]` screens (config, gallery ...) keeps it. The history lives only in memory: it is
  gone after closing the game or a page reload (e.g. some games' "back to title").
- A click is only treated as a transition skip when the engine is not waiting for input: not at
  `[s]` (choices/buttons), not in a menu, not on a button or link, and not while a text line is
  typing or waiting for a click (the game handles those clicks as usual).

Tested with TyranoScript v5.00 (TrashxTALK, Electron 7), v5.20 (Within a Gentle Cage, Electron 24)
and the v4.50 engine that ships with TyranoBuilder 1.80 (NW.js 0.12 / Chrome 41).

Note: while a game runs through the patcher, its DevTools port is reachable by other programs on
this PC (localhost only), as with any Chromium app started with remote debugging.

## Building

```
powershell -File build.ps1
```

Output: `build\TyranoPatcher.exe` (the `.config` file next to it is optional).
