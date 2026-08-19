# Native Codex plugin architecture

## Why the interface appears to change

`interface.composerIcon` adds a native plugin entry. The plugin's `open_visual_workspace` tool returns an MCP App `ui://` resource and requests `fullscreen`. If Codex grants it, the host gives its main content area to the widget while retaining the host-owned outer chrome and composer. If the host keeps `inline`, the same widget stays usable and reports that decision. The widget may implement its own tool rail, canvas, asset library, and inspector, which makes it look like a different application without patching the host.

There is no supported contribution point in the current manifest or MCP Apps protocol for arbitrary global CSS, host DOM mutation, or permanent replacement of Codex's native task sidebar. Do not claim otherwise.

## Research basis

- The stable [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx) defines apps as sandboxed `ui://` views and makes display modes a host/view negotiation. A view must accept the actual mode returned by the host.
- OpenAI's [plugin UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui) recommends fullscreen for maps and editing canvases, while the host-owned composer remains present.
- [SEP-2577](https://modelcontextprotocol.io/seps/2577-deprecate-roots-sampling-and-logging) deprecates MCP roots and recommends explicit alternatives such as tool parameters, resource URIs, server configuration, or environment variables. Roots therefore remain a progressive enhancement, not a startup requirement.
- Mapbox's [MCP server](https://github.com/mapbox/mcp-server) is a representative public implementation: its rich map is a panel inside chat with a fullscreen toggle in supported hosts, not a global host-shell patch.
- Linux.do posts showing Codex browser sidebars ([example 1](https://linux.do/t/topic/2560684?tl=en), [example 2](https://linux.do/t/topic/2559871?tl=en)) document host/browser integration behavior. They are useful community UX evidence, but do not establish a third-party plugin contribution point for replacing Codex chrome.

## Runtime boundary

```text
Codex composer icon or explicit conversation request
  -> open_visual_workspace(projectDir)
  -> stdio MCP server
  -> ui://widget/visual-workspace/canvas.html
  -> host roots contain project: issue a task-scoped session capability
     exact project has an app-click approval, or a validated linked worktree inherits it: issue a session capability
     otherwise: show exact path and require one in-widget user click
  -> requestDisplayMode(fullscreen), consume the actual returned mode
  -> widget calls bounded MCP tools for scan / preview / canvas state
  -> explicit handoff attaches selected paths as structured context without sending a message
```

No HTTP server or TCP port is required. Project image files are scanned and read only. Canvas arrangement is stored under the user's application-support/state directory, not in the client project.

## Security boundary

- The model-visible open tool cannot create a new approval by itself. Project registration requires a matching host root or an explicit click in the native consent screen. Broad filesystem and home-directory roots are rejected.
- A later open may reuse an app-click-approved exact realpath. A Codex worktree may inherit that approval only after its regular `.git` pointer, worktree-admin backlink, `commondir`, and Git common-directory identity all validate against a previously approved repository; an unrelated repository still requires its own first approval. Host-root catalog entries are marked separately and cannot create cross-task remembered trust without a later widget click.
- Pending click approvals are opaque, bounded to 512 entries, stored in the user-level state directory with a 12-hour expiry, and consumed atomically once. This keeps a visible consent card usable across a normal MCP server restart without exposing its project path to model-visible structured output.
- Later app-only tools require both the opaque `workspaceId` and an in-memory access capability. Neither capability is exposed in model-visible structured output. This boundary relies on the MCP Apps host honoring `_meta` as model-hidden and enforcing `ui.visibility: ["app"]`, as required by the host integration; the server additionally treats the token as the sole bearer secret.
- Widget teardown requests immediate capability revocation. If host teardown is interrupted, sessions expire after 2 hours idle and have an absolute 12-hour lifetime.
- Files must be regular supported images, remain inside the approved real project root, and pass realpath validation each time they are previewed or returned as a selection.
- Recursive scan skips symlinks, hidden/build/dependency directories and has depth, count, and time caps.
- Canvas writes use an external lock, revision comparison, temporary file, and atomic rename.
- The widget renders all file names with DOM `textContent`; CSP allows only in-memory `data:`/`blob:` resources.
- Removing a canvas node never deletes or moves the source image.

## Display modes

The widget advertises `inline` and `fullscreen`. Fullscreen is preferred for the image canvas, but the Codex host may refuse or choose another available mode. The widget checks the modes offered by the host, applies the actual returned mode, shows a visible refusal message, and remains usable inline. Every open request also receives a short-lived in-memory receipt id: an app-only tool reports only the requested mode, actual mode, offered modes, and outcome; the model-visible receipt reader can then inspect the host decision without exposing a project path or access token. This receipt is a bounded diagnostic emitted by the sandboxed widget, not a host-signed attestation.

## Verification layers

1. Syntax and storage tests: `npm run check && npm test`
2. MCP tools/resource protocol: `npm run probe:mcp`
3. Standalone release build and no-`node_modules` probe: `npm run build && npm run verify:release`
4. Light/dark/reduced-motion/XSS/layout and interaction QA: `npm run verify:widget`
5. Manifest validation: plugin-creator `validate_plugin.py`
6. Installed source: `codex plugin list` and repeat the quality gate in the installed cache
7. Host pickup: open a new task (or refresh/restart after marketplace changes), confirm the composer icon, exercise first approval plus direct reopening from a linked worktree, and record the actual display mode granted by Codex
