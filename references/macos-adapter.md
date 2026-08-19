# macOS adapter

## Scope

The macOS adapter changes discovery, paths, lifecycle, launcher, and path validation. It does not replace the native Codex/ChatGPT information architecture, weaken the Asset Console token/origin/session checks, or modify the application bundle.

## Design evidence

- The stable [MCP Apps 2026-01-26 specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) defines `inline`, `fullscreen`, and `pip`, requires the View to declare supported modes, and requires it to handle an actual mode different from the request.
- The official [Codex App Server documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) documents thread, skill, app, plugin, MCP, approval, stdio, and Unix-socket surfaces. This adapter does not claim access to the Desktop app's private in-process App Server session.
- Community projects [Taskboard](https://github.com/izscc/taskboard) and [Explodex](https://github.com/dan-dr/explodex/blob/main/docs/codex-architecture.md) demonstrate loopback-CDP injection, OOPIF/CSP constraints, and stable portal/side-panel anchors. They are design references, not compatibility guarantees; every supported Codex build still needs local host acceptance.
- [Apple HIG Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars), [VS Code UX Guidelines](https://code.visualstudio.com/api/ux-guidelines/overview), and [GitHub Primer Product UI](https://primer.style/product/) guide the 48px launcher, complementary panel, three primary modes, contextual actions, and responsive split-layout behavior.
- The project root [DESIGN.md](../DESIGN.md) follows the open Google Stitch DESIGN.md structure and preserves the repository's earlier creative-cockpit, source-preserving canvas, CSP/XSS, accessibility, and transactional install requirements.

## Capability map

| Capability | macOS implementation | Failure behavior |
| --- | --- | --- |
| Desktop discovery | `/Applications/Codex.app`, then `/Applications/ChatGPT.app` | Report absent; do not create or patch an app bundle |
| Debug transport | Loopback CDP on `127.0.0.1:9231` | Injector waits; ordinary web targets are rejected |
| Workspace panel | Per-open private OOPIF proxy over the same CDP session; native workspace data stays on stdio MCP | Wrong origin, nonce, frame, route, task, or approval state fails closed |
| User startup | `~/Library/LaunchAgents/com.yubowen.codex-sidebar-enhancer.plist` | Ownership mismatch blocks install/uninstall |
| User launcher | `~/Applications/Codex Sidebar Enhancer.app` | Opens a separate enhanced instance; ordinary ChatGPT/Codex windows are left untouched |
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
4. `--activate` installs the enhancer transactionally and loads the per-user LaunchAgent without restarting the desktop app. The bundled legacy installer may also update AssetBrowser runtime while preserving its user data.
5. `scripts/verify-macos.mjs --installed` binds validation to the installed copy.

The first visible activation is intentionally separate: open `~/Applications/Codex Sidebar Enhancer.app`. Its default `--mode enhanced-window` launches an isolated instance with loopback CDP even when an ordinary Codex window is already open. `--mode attach-existing --port 9231` connects only to an explicitly prepared endpoint. `--mode stop` unloads the owned injector and terminates only app processes carrying the exact configured debugging-port marker; it does not use `killall` or `pkill`.

The modern workspace panel does not require the legacy AssetBrowser server on port `5177`. It discovers the installed `codex-workspace-enhancer` plugin, opens the exact task project through the native MCP server, and keeps workspace IDs and access tokens outside browser JavaScript.

## UI material policy

Use translucent glass for navigation, toolbars, segmented controls, and floating status surfaces. Keep media grids, metadata, editable content, and dense lists on calmer opaque or near-opaque content materials. Provide solid fallbacks for reduced transparency, reduced motion, increased contrast, and environments without `backdrop-filter`.

## Verification boundary

Deterministic installation, hashes, LaunchAgent syntax/load state, closed-CDP state, DOM syntax, UI layout, and reduced-effect fallbacks can be verified locally. Task A → B iframe invalidation, native MCP approval reuse, and live renderer injection require a desktop process started with the debug launcher; do not label those verified merely because installation succeeded.
