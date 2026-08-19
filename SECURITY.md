# Security policy

## Supported versions

Security fixes are applied to the latest `0.2.x` source and plugin release. Older local snapshots and legacy adapters may not receive fixes.

## Report a vulnerability

Please use GitHub's **Report a vulnerability** / private security advisory flow for this repository. Do not include tokens, private project paths, client assets, or other sensitive data in a public issue.

Include the affected version, operating system, Codex version, reproduction steps, expected boundary, and the smallest non-sensitive evidence needed to reproduce the problem.

## Native-plugin trust model

- The model-visible open tool receives an absolute project path but does not scan project images until a matching host root or explicit in-widget approval exists.
- App-only tools require an opaque session capability. The capability is not returned in model-visible structured output.
- Every asset read revalidates realpath containment and rejects symbolic links, unsupported extensions, control characters, and oversized previews.
- Native-plugin features communicate over stdio and do not start a localhost server.
- Canvas state is stored outside the project in a user-level application-data directory using revision checks, a lock, a temporary file, and atomic rename.
- The plugin depends on an MCP Apps host enforcing app-only tool visibility and model-hidden `_meta` data. A non-conforming host is outside this security boundary.
- Selection handoff updates structured conversation context only. It does not submit a user message.

## Legacy adapter warning

The optional legacy adapters under `assets/runtime/` use CDP and authenticated loopback services. Their boundaries differ from the native plugin. Keep them stopped unless explicitly required, and never expose their ports beyond loopback.
