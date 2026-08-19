# Codex Workspace Enhancer

**A native, port-free visual workspace for OpenAI Codex.** Arrange project images, references, and creative notes on an infinite canvas without patching the Codex app or exposing a localhost service.

[简体中文](README.zh-CN.md) · [Architecture](references/native-plugin.md) · [Security](SECURITY.md) · [AI-readable summary](llms.txt)

[![CI](https://github.com/papperrollinggery/codex-workspace-enhancer/actions/workflows/ci.yml/badge.svg)](https://github.com/papperrollinggery/codex-workspace-enhancer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MCP Apps](https://img.shields.io/badge/MCP-Apps-6C83FF)](https://github.com/modelcontextprotocol/ext-apps)

![Codex Workspace Enhancer native visual canvas](plugin/codex-workspace-enhancer/artifacts/native-visual-workspace-light.png)

## What it solves

Creative work in Codex often spans reference images, generated frames, notes, and repeated comparison. Codex Workspace Enhancer keeps that visual context inside the current conversation:

- Open from the Codex composer as a native MCP App.
- Browse approved project images without copying them into a cloud service.
- Pan, zoom, resize, multi-select, and organize images on an infinite canvas.
- Add creative notes and preserve a revisioned board between sessions.
- Attach selected local image paths to the conversation context without automatically sending a message.
- Request fullscreen while remaining usable inline when the host declines or does not support it.

The preferred native plugin uses **stdio**, `ui://` resources, and a bundled standalone MCP server. It does not open a TCP port, inject CSS into Codex, modify `/Applications/ChatGPT.app` or `/Applications/Codex.app`, or replace host-owned chrome.

## Install from GitHub

Requirements:

- Codex CLI/app with plugin and MCP Apps support.
- Node.js 20 or newer available as `node`.

```bash
codex plugin marketplace add papperrollinggery/codex-workspace-enhancer --ref main
codex plugin add codex-workspace-enhancer@codex-workspace-enhancer
```

Open a **new Codex task** after installation so the host loads the plugin, composer icon, skill, and MCP tools. Then ask:

```text
Open the native visual workspace for this project.
```

If Codex does not provide workspace roots, the widget shows the exact project path and waits for an explicit in-widget approval before scanning images.

## Safety and privacy model

| Boundary | Behavior |
|---|---|
| Project access | Exact-path approval or a matching host-provided workspace root |
| Source images | Read-only; canvas removal never deletes or moves the file |
| Paths | Realpath containment checks and symlink escape rejection |
| Preview loading | 12 MB per image, three concurrent reads, bounded LRU object-URL cache |
| Project scanning | Skips hidden/build/dependency folders; at most 600 images, 7 levels, 20,000 entries, or 3.5 seconds |
| Session access | Opaque in-memory capability; 2-hour idle and 12-hour absolute expiry |
| Canvas state | Approved absolute project root plus revisioned canvas JSON in the user's application-data directory; no upload |
| Conversation handoff | Structured context only; the user still sends the next message |
| Network | No listening socket for native-plugin features |

Fullscreen is a host-negotiated display mode, not a plugin guarantee. The diagnostic receipt records the initial requested mode and the app-reported actual mode; it is not a host-signed attestation. In the host snapshot tested on 2026-08-18, no plugin tool was exposed for programmatically closing the fullscreen surface; re-check this version-specific capability after host updates.

See [SECURITY.md](SECURITY.md) for the trust model and vulnerability reporting.

## Develop and verify

```bash
git clone https://github.com/papperrollinggery/codex-workspace-enhancer.git
cd codex-workspace-enhancer
npm run setup
npm run quality
```

`npm run quality` performs syntax checks, native storage tests, MCP protocol probes, a standalone release probe without `node_modules`, Playwright interaction/visual QA, legacy adapter tests, and bundled-runtime hash verification.

Focused native-plugin workflow:

```bash
cd plugin/codex-workspace-enhancer
npm ci
npx playwright install chromium
npm run quality
```

The release build commits `plugin/codex-workspace-enhancer/dist/server.mjs`, so a Git Marketplace installation does not depend on running `npm install` inside Codex's plugin cache.

## Repository map

```text
.agents/plugins/marketplace.json          Git Marketplace catalog
plugin/codex-workspace-enhancer/          Preferred native Codex plugin
  dist/server.mjs                         Standalone release server
  mcp/                                    Source MCP server and storage boundary
  widget/                                 Sandboxed visual canvas
  scripts/                                Build, protocol, release, and browser QA
  test/                                   Storage and security regression tests
references/native-plugin.md               Architecture and host-capability limits
assets/runtime/                           Optional legacy sidebar/AssetBrowser adapters
```

## Native plugin vs. legacy adapters

The native plugin is the default and needs no localhost service. `assets/runtime/enhancer/` and `assets/runtime/asset-browser/` are retained for older sidebar and advanced AssetBrowser workflows. Those adapters have different CDP/local-service security boundaries and must remain stopped unless their capabilities are explicitly needed.

## Canonical facts for search and AI citation

- **Project:** Codex Workspace Enhancer
- **Product type:** OpenAI Codex plugin, local MCP server, and MCP App visual canvas
- **Primary use:** visual reference management and creative image comparison inside a Codex conversation
- **Transport:** stdio; no TCP listener in the native plugin
- **Data model:** read-only project images plus user-level revisioned canvas state
- **Display modes:** inline and host-negotiated fullscreen
- **Repository:** <https://github.com/papperrollinggery/codex-workspace-enhancer>
- **License:** MIT, with preserved third-party notices for the legacy adapter and bundled dependencies

For deterministic machine-readable context, use [llms.txt](llms.txt). `llms.txt` is a proposed community format; this project does not claim it is a search-ranking factor or universally consumed by AI systems.

## Project status

The native plugin has automated source, protocol, security, standalone-release, and browser interaction coverage. Installed-host behavior remains version-specific: verify the composer entry, in-widget approval, and actual display receipt after each Codex or plugin update.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md). The project is MIT licensed; bundled or adapted third-party components retain their own notices in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and local license files.
