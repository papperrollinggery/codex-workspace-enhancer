import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { McpStdioClient } from "./mcp-stdio-client.mjs";

async function regularFile(value) {
  const requestedStats = await lstat(value).catch(() => null);
  if (!requestedStats?.isFile() || requestedStats.isSymbolicLink()) return null;
  const resolved = await realpath(value).catch(() => null);
  if (!resolved) return null;
  const stats = await lstat(resolved).catch(() => null);
  return stats?.isFile() && !stats.isSymbolicLink() ? resolved : null;
}

function compareVersion(left, right) {
  const parts = (value) => String(value).split(/[.+-]/u).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

async function candidateFromPluginRoot(pluginRoot) {
  const manifestFile = await regularFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
  const serverEntry = await regularFile(path.join(pluginRoot, "dist", "server.mjs"));
  if (!manifestFile || !serverEntry) return null;
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (manifest.name !== "codex-workspace-enhancer" || compareVersion(manifest.version, "0.2.2") < 0) return null;
  return { pluginRoot: await realpath(pluginRoot), serverEntry, version: manifest.version };
}

export async function discoverInstalledVisualWorkspace({ codexHome = path.join(os.homedir(), ".codex"), explicitServerPath } = {}) {
  if (explicitServerPath) {
    const serverEntry = await regularFile(explicitServerPath);
    if (!serverEntry) throw new Error("Visual Workspace server is not a regular file");
    const pluginRoot = path.resolve(path.dirname(serverEntry), "..");
    const candidate = await candidateFromPluginRoot(pluginRoot);
    if (!candidate) throw new Error("Visual Workspace plugin manifest is invalid or too old");
    return candidate;
  }
  const cacheRoot = path.join(codexHome, "plugins", "cache");
  const candidates = [];
  for (const marketplace of await readdir(cacheRoot, { withFileTypes: true }).catch(() => [])) {
    if (!marketplace.isDirectory()) continue;
    const pluginRoot = path.join(cacheRoot, marketplace.name, "codex-workspace-enhancer");
    for (const version of await readdir(pluginRoot, { withFileTypes: true }).catch(() => [])) {
      if (!version.isDirectory()) continue;
      const candidate = await candidateFromPluginRoot(path.join(pluginRoot, version.name)).catch(() => null);
      if (candidate) candidates.push(candidate);
    }
  }
  candidates.sort((left, right) => compareVersion(right.version, left.version));
  if (!candidates[0]) throw new Error("Installed Visual Workspace plugin was not found");
  return candidates[0];
}

function payload(result) {
  if (result?.isError) {
    throw new Error(result.content?.find((item) => item.type === "text")?.text || "Visual Workspace tool call failed");
  }
  return result?.structuredContent || {};
}

export class NativeWorkspaceClient {
  constructor({ serverEntry, pluginRoot, command = process.execPath, env, timeoutMs = 15_000 } = {}) {
    if (!serverEntry) throw new Error("Visual Workspace server entry is required");
    this.serverEntry = serverEntry;
    this.pluginRoot = pluginRoot || path.resolve(path.dirname(serverEntry), "..");
    this.transport = new McpStdioClient({ command, args: [serverEntry], cwd: this.pluginRoot, env, timeoutMs });
    this.session = null;
  }

  async openApprovedWorkspace({ projectDir, displayMode = "inline" }) {
    if (this.transport.state === "idle") await this.transport.connect();
    const result = await this.transport.callTool("open_visual_workspace", { projectDir, displayMode });
    const visible = payload(result);
    const privateData = result?._meta?.widgetData || {};
    if (visible.accessState === "approved") {
      if (!privateData.workspaceId || !privateData.accessToken) throw new Error("Approved workspace did not return a private session");
      this.session = {
        workspaceId: privateData.workspaceId,
        accessToken: privateData.accessToken,
        projectRoot: privateData.projectRoot,
        projectName: privateData.projectName,
      };
    } else {
      this.session = null;
    }
    return {
      accessState: visible.accessState,
      authorizationSource: visible.authorizationSource,
      preferredDisplayMode: visible.preferredDisplayMode,
      displayReceiptId: visible.displayReceiptId,
      projectName: privateData.projectName || null,
      projectRoot: privateData.projectRoot || null,
    };
  }

  async loadWorkspace() {
    return payload(await this.#sessionTool("get_visual_workspace", { workspaceId: this.session?.workspaceId }));
  }

  async readAsset(relPath) {
    return payload(await this.#sessionTool("read_visual_workspace_asset", { workspaceId: this.session?.workspaceId, relPath }));
  }

  async saveBoard({ baseRev, viewport, nodes, selectedIds }) {
    return payload(await this.#sessionTool("save_visual_workspace", { workspaceId: this.session?.workspaceId, baseRev, viewport, nodes, selectedIds }));
  }

  async selection() {
    return payload(await this.#sessionTool("get_visual_workspace_selection", { workspaceId: this.session?.workspaceId }));
  }

  async close() {
    if (this.session && this.transport.state === "ready") {
      await this.#sessionTool("revoke_visual_workspace_access", { workspaceId: this.session.workspaceId }).catch(() => {});
    }
    this.session = null;
    await this.transport.close();
  }

  async #sessionTool(name, arguments_) {
    if (!this.session) throw new Error("Visual Workspace session is not approved");
    return this.transport.callTool(name, { ...arguments_, accessToken: this.session.accessToken });
  }
}
