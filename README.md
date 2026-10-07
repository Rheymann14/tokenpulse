# AI Usage Monitor

An always-on-top Windows desktop widget for Codex and Claude Code subscription limits. Shows used and remaining percentages, scheduled resets, and the age of each reading. Usage refreshes every two minutes. Reset times use Philippine time (Asia/Manila); hover a reset to see the full date, time, and remaining countdown.

## Run

Install Node.js, Rust, and the Windows Tauri prerequisites (Microsoft C++ Build Tools and WebView2). Then:

```powershell
npm install
npm run tauri dev
```

The widget opens at 300 × 340 pixels, with an icon for adding or switching Codex accounts and compact account cards. All accounts appear together without pages or a scrollbar. The detailed window grows as needed to fit the cards. Each Codex account is labeled with its signed-in email. Session and weekly limits appear side by side. Session resets show the time; weekly resets show the date and time. Hover a percentage for remaining usage, a reset for its full timestamp and countdown, or a truncated error for its full message. Additional Claude model-specific limits appear in the update timestamp tooltip.

Drag the heading to move the widget, and the bottom-right grip to resize it. The minimum size is 280 × 330 pixels. Codex bars are blue and Claude Code bars are orange; both turn red at 95% usage. Use the refresh icon in the heading to fetch new readings, and the close button or taskbar to exit. The manual refresh button has a ten-second cooldown.

```powershell
npm run tauri build
```

Built installers appear under `src-tauri/target/release/bundle`.

`npm run dev` opens a frontend preview only. Account readers require the Tauri desktop app; the browser displays connection instructions rather than fake usage.

## Account connections

**Codex:** Queries the installed Codex App Server using `account/read` and `account/rateLimits/read`. Each refresh starts a hidden helper, identifies the signed-in email, fetches subscription limits, and shuts the helper down. No model requests or conversation turns are created. The helper has a 25-second response deadline. The widget finds Codex on PATH or in the installed Windows VS Code extension; set `CODEX_BINARY` to the executable path if needed. Codex uses its existing login and honors `CODEX_HOME`.

**Connect / switch Codex accounts:** Click the person-plus icon in the header (**Switch / add Codex account**). The widget opens the official ChatGPT sign-in page in your default browser and waits for sign-in to finish. Choose the desired account in the browser; if the browser automatically uses a previous account, switch the browser's ChatGPT account and try again. The widget automatically detects the signed-in email, adds its row, and refreshes usage. **Open sign-in** reopens the browser if needed. **Cancel** stops the pending attempt. Attempts expire after five minutes, and the hidden helper is cleaned up on cancellation, completion, expiry, or application shutdown. A webview reload can resume a pending sign-in.

**Shared Codex login:** This widget uses the installed Codex login and honors `CODEX_HOME`. Switching or disconnecting here also changes the login used by Codex CLI / IDE clients sharing that configuration. It does not maintain independent signed-in sessions for every account. Select an account card, then click its **Disconnect** button. For the signed-in account this signs out through Codex and removes the card; for a saved account this removes its saved reading from the widget without signing out the current account. The button remains usable during a refresh, waits for the reader to finish, and verifies the account before logging out. Only the current account can refresh. Sign in again to refresh a previously used account. All disconnect actions are available on the selected card. Existing CHED/Gmail snapshots migrate automatically to the new account list. The cache stores usage and email only, never credentials.

**Claude Code:** Reuses the subscription OAuth login in `%USERPROFILE%/.claude/.credentials.json`, or `CLAUDE_CONFIG_DIR` when set, to fetch account usage from Anthropic. Sign in using Claude Code first. API-key-only accounts are not supported. Credentials stay in the Rust backend and are sent only to `https://api.anthropic.com`; they are never returned to the frontend, logged, or saved by this app. The widget does not refresh or change the installed credentials. If the login expires, open Claude Code to renew it, then refresh the widget.

Claude's `/api/oauth/usage` endpoint is undocumented and may change. The connection was verified against the installed account during development. Optional Sonnet and Opus weekly windows appear when returned by the endpoint. A null reset time means no scheduled reset was reported.

Errors retain the last successful reading and mark it as last known usage. Readings older than 15 minutes are also labeled last known usage. Once a reset timestamp passes, the widget marks that window as awaiting an update; it does not assume usage became zero.

## Compact pin mode

Click the pin icon to shrink the widget to a compact view anchored at the bottom right of the current monitor, above the taskbar. It shows every account, session/weekly percentages, progress bars, and saved/stale markers. Account details and reset schedules return when you unpin. The widget restores its previous size and position, continues refreshing while pinned, and stays above other windows. Pinned windows cannot be dragged or resized; unpin to move them. Window height adjusts when accounts or messages change.

## Validation

```powershell
npm test
npm run build
cd src-tauri
cargo test --lib
```

An optional integration check queries your signed-in Codex account and calls Anthropic using your installed Claude login. It prints only the number of usage windows:

```powershell
cargo test --lib installed_account_readers -- --ignored --nocapture
```

Provider references: [Codex App Server account and rate-limit methods](https://learn.chatgpt.com/docs/app-server) and [Claude Code usage fields](https://code.claude.com/docs/en/statusline). Claude integration uses its account endpoint.
