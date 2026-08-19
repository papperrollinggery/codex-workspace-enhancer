import { readGitContext } from "./panel-context.mjs";

function json(status, payload) {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    body: JSON.stringify(payload),
  };
}

function pathname(route) {
  try { return new URL(route, "https://panel.local").pathname; } catch { return ""; }
}

export class WorkspacePanelBridge {
  constructor({ context, openResult, nativeClient, actionHandler, version = "0.3.0", maxRequestBytes = 1024 * 1024 } = {}) {
    if (!context?.threadId || !context?.projectDir) throw new Error("Workspace Panel context is incomplete");
    if (!nativeClient) throw new Error("Workspace Panel native client is required");
    this.context = context;
    this.openResult = openResult || { accessState: "unavailable", authorizationSource: "unavailable" };
    this.nativeClient = nativeClient;
    this.actionHandler = actionHandler;
    this.version = version;
    this.maxRequestBytes = maxRequestBytes;
  }

  async handle({ method = "GET", route = "/", body = "" } = {}) {
    if (Buffer.byteLength(body || "") > this.maxRequestBytes) return json(413, { error: "Workspace Panel request is too large" });
    const target = pathname(route);
    if (target === "/api/status" && method === "GET") return json(200, this.publicStatus());
    if (["/api/workspace", "/api/asset/read", "/api/board/save", "/api/selection"].includes(target) && !this.#approved()) {
      return json(409, {
        error: "Project approval is required in native Visual Workspace",
        accessState: this.openResult.accessState,
        authorizationSource: this.openResult.authorizationSource,
      });
    }
    if (target === "/api/workspace" && method === "GET") return json(200, await this.nativeClient.loadWorkspace());
    if (target === "/api/asset/read" && method === "POST") {
      const input = this.#input(body);
      if (typeof input.relPath !== "string" || !input.relPath) return json(400, { error: "relPath is required" });
      return json(200, await this.nativeClient.readAsset(input.relPath));
    }
    if (target === "/api/board/save" && method === "POST") return json(200, await this.nativeClient.saveBoard(this.#input(body)));
    if (target === "/api/selection" && method === "GET") return json(200, await this.nativeClient.selection());
    if (target === "/api/tasks" && method === "GET") {
      return json(200, { tasks: [{ threadId: this.context.threadId, title: this.context.title || "当前任务", status: "current" }] });
    }
    if (target === "/api/changes" && method === "GET") {
      const latest = await readGitContext(this.context.projectDir);
      return json(200, latest.worktreeRoot ? latest.git : (this.context.git || { branch: "", dirtyCount: 0, ahead: 0, behind: 0, paths: [] }));
    }
    if (target === "/api/tools" && method === "GET") {
      return json(200, { tools: [
        { id: "visual-workspace", label: "Visual Workspace", available: true, action: "native-mcp-app" },
        { id: "plugins", label: "插件与 Skill", available: true, action: "native-route" },
        { id: "browser", label: "浏览器", available: true, action: "native-route" },
        { id: "review", label: "Review", available: true, action: "native-route" },
        { id: "terminal", label: "终端", available: true, action: "native-route" },
      ] });
    }
    if (target === "/api/tools/action" && method === "POST") {
      const input = this.#input(body);
      const allowed = new Set(["visual-workspace", "plugins", "browser", "review", "terminal"]);
      if (!allowed.has(input.actionId) || typeof this.actionHandler !== "function") {
        return json(400, { error: "Workspace Panel action is not available" });
      }
      const result = await this.actionHandler(input.actionId);
      return json(200, {
        action: typeof result?.action === "string" ? result.action : "unavailable",
        sent: false,
      });
    }
    return json(404, { error: "Workspace Panel route was not found" });
  }

  publicStatus() {
    return {
      version: this.version,
      bridgeState: this.#approved() ? "ready" : "approval-required",
      threadId: this.context.threadId,
      threadTitle: this.context.title || "",
      projectDir: this.context.projectDir,
      projectName: this.openResult.projectName || "",
      accessState: this.openResult.accessState,
      authorizationSource: this.openResult.authorizationSource,
    };
  }

  async close() {
    await this.nativeClient.close?.();
  }

  #approved() {
    return this.openResult.accessState === "approved" && Boolean(this.nativeClient.session);
  }

  #input(body) {
    try { return JSON.parse(body || "{}"); } catch { throw new Error("Workspace Panel request body is invalid JSON"); }
  }
}
