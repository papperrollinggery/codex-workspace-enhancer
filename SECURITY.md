# Security policy

## Supported versions

Security fixes are applied to the latest `0.2.x` source and plugin release. Older local snapshots and legacy adapters may not receive fixes.

## Report a vulnerability

Please use GitHub's **Report a vulnerability** / private security advisory flow for this repository. Do not include tokens, private project paths, client assets, or other sensitive data in a public issue.

Include the affected version, operating system, Codex version, reproduction steps, expected boundary, and the smallest non-sensitive evidence needed to reproduce the problem.

## Native-plugin trust model

- The model-visible open tool receives an absolute project path but cannot grant a new project to itself. A new project requires a matching host root or one explicit in-widget approval. Later calls may reopen that exact realpath or a linked worktree only after validating that both resolve to the same Git common directory and backlink metadata.
- Catalog entries record their approval source. Only an app-click approval and its validated inherited worktrees are reusable without host roots; a host-root grant remains scoped to tasks whose host still supplies a matching root.
- Pending in-widget approvals are opaque, atomically single-use, bounded to 512 local records, and expire after 12 hours. Their state file is atomically claimed during mutation so concurrent processes cannot consume the same request. Session capabilities remain model-hidden and in memory only.
- App-only tools require an opaque session capability. The capability is not returned in model-visible structured output.
- Every asset read revalidates realpath containment and rejects symbolic links, unsupported extensions, control characters, and oversized previews.
- Native-plugin features communicate over stdio and do not start a localhost server.
- Canvas state is stored outside the project in a user-level application-data directory using revision checks, a lock, a temporary file, and atomic rename.
- The plugin depends on an MCP Apps host enforcing app-only tool visibility and model-hidden `_meta` data. A non-conforming host is outside this security boundary.
- Selection handoff updates structured conversation context only. It does not submit a user message.

## Legacy adapter warning

The optional legacy adapters under `assets/runtime/` use CDP and authenticated loopback services. Their boundaries differ from the native plugin. Keep them stopped unless explicitly required, and never expose their ports beyond loopback.
