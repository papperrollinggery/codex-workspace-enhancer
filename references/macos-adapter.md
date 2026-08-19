# macOS adapter

## Scope

The macOS adapter changes discovery, paths, lifecycle, launcher, and path validation. It does not replace the native Codex/ChatGPT information architecture, weaken the Asset Console token/origin/session checks, or modify the application bundle.

## Capability map

| Capability | macOS implementation | Failure behavior |
| --- | --- | --- |
| Desktop discovery | `/Applications/ChatGPT.app`, then `/Applications/Codex.app` | Report absent; do not create or patch an app bundle |
| Debug transport | Loopback CDP on `127.0.0.1:9231` | Injector waits; ordinary web targets are rejected |
| User startup | `~/Library/LaunchAgents/com.yubowen.codex-sidebar-enhancer.plist` | Ownership mismatch blocks install/uninstall |
| User launcher | `~/Applications/Codex Sidebar Enhancer.app` | Running ChatGPT/Codex is left untouched and the user is prompted to quit normally |
| Enhancer runtime | `~/Library/Application Support/Codex Sidebar Enhancer` | Exact-root and ownership-marker checks |
| Enhancer state | `~/Library/Application Support/CodexSidebarEnhancer` | Preserved during update and removed only by the owned uninstaller |
| AssetBrowser runtime/data | `~/Library/Application Support/AssetBrowser` | Runtime files are manifest-owned; config, token, ledgers, projects and media remain user-owned |
| Asset paths | POSIX absolute paths on macOS; drive/UNC paths retained for Windows | Relative paths, `~`, URLs, NUL and newline input are rejected |
| Python helper | `python3`, then explicit compatible fallbacks | Return a clear unavailable error; never guess a script result |
| Installer assets | `.app`, `.dmg`, `.pkg` plus retained Windows package recognition | Unsupported package type is reported, not executed |
| Creative delivery safety | FinalDelivery/成片/最终输出/生成记录/reference and today's daily-output areas | Destructive cleanup and automation fail closed |

## Install lifecycle

1. `scripts/inspect-macos.mjs` performs a read-only machine and installation audit.
2. `scripts/build-macos-manifest.mjs` records source hashes.
3. `scripts/install-bundled-macos.mjs --dry-run` reports exact targets and preservation rules.
4. `--activate` installs backend runtime files and the enhancer transactionally, creates a private API token if absent, and loads the per-user LaunchAgent without restarting the desktop app.
5. `scripts/verify-macos.mjs --installed` binds validation to the installed copy.

The first visible activation is intentionally separate: quit ChatGPT/Codex normally, then open `~/Applications/Codex Sidebar Enhancer.app`. This prevents the installer from killing the task that is performing the installation.

## UI material policy

Use translucent glass for navigation, toolbars, segmented controls, and floating status surfaces. Keep media grids, metadata, editable content, and dense lists on calmer opaque or near-opaque content materials. Provide solid fallbacks for reduced transparency, reduced motion, increased contrast, and environments without `backdrop-filter`.

## Verification boundary

Deterministic installation, hashes, LaunchAgent syntax/load state, authenticated AssetBrowser health, DOM syntax, UI layout, and reduced-effect fallbacks can be verified locally. Task A → B iframe invalidation and live renderer injection require a desktop process started with the debug launcher; do not label those verified merely because installation succeeded.
