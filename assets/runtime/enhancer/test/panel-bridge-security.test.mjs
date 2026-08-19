import assert from "node:assert/strict";
import test from "node:test";

const embed = await import("../lib/workspace-panel-embed.mjs").catch(() => ({}));
const bridgeModule = await import("../lib/workspace-panel-bridge.mjs").catch(() => ({}));

test("exports private panel routing and bridge modules", () => {
  assert.equal(typeof embed.workspacePanelEmbedUrl, "function", "panel embed URL helper is missing");
  assert.equal(typeof embed.workspacePanelRoute, "function", "panel route helper is missing");
  assert.equal(typeof bridgeModule.WorkspacePanelBridge, "function", "WorkspacePanelBridge is missing");
});

test("accepts only the exact synthetic origin, nonce, and allowed API routes", () => {
  const token = "a".repeat(48);
  const base = embed.workspacePanelEmbedUrl(token);
  assert.equal(embed.workspacePanelRoute(`${base}panel.js`, { token }), "/panel.js");
  assert.equal(embed.workspacePanelRoute(`${base}api/status`, { token, panelSession: true }), "/api/status");
  assert.equal(embed.workspacePanelRoute(`${base}api/tools/action`, { token, panelSession: true }), "/api/tools/action");
  assert.equal(embed.workspacePanelRoute(`${base}api/unknown`, { token, panelSession: true }), null);
  assert.equal(embed.workspacePanelRoute(`${base}api/status`, { token, panelSession: false }), null);
  assert.equal(embed.workspacePanelRoute(`https://evil.example${new URL(base).pathname}panel.js`, { token }), null);
  assert.equal(embed.workspacePanelRoute(embed.workspacePanelEmbedUrl("b".repeat(48)), { token }), null);
});

test("native tool actions remain allowlisted and never report a sent message", async () => {
  const actions = [];
  const bridge = new bridgeModule.WorkspacePanelBridge({
    context: { threadId: "thread", title: "Panel", projectDir: "/project" },
    openResult: { accessState: "approved", authorizationSource: "previous-approval" },
    nativeClient: { session: { workspaceId: "private", accessToken: "secret" } },
    actionHandler: async (actionId) => {
      actions.push(actionId);
      return { action: "composer-prefilled", sent: false };
    },
  });
  const response = await bridge.handle({
    method: "POST",
    route: "/api/tools/action",
    body: JSON.stringify({ actionId: "review" }),
  });
  assert.deepEqual(JSON.parse(response.body), { action: "composer-prefilled", sent: false });
  assert.deepEqual(actions, ["review"]);
  assert.equal((await bridge.handle({
    method: "POST",
    route: "/api/tools/action",
    body: JSON.stringify({ actionId: "submit" }),
  })).status, 400);
});

test("returns public status without session capabilities", async () => {
  const bridge = new bridgeModule.WorkspacePanelBridge({
    context: { threadId: "thread", title: "Panel", projectDir: "/project" },
    openResult: { accessState: "approved", authorizationSource: "previous-approval", projectName: "Project" },
    nativeClient: { session: { workspaceId: "private", accessToken: "secret" } },
    version: "0.3.0",
  });
  const response = await bridge.handle({ method: "GET", route: "/api/status" });
  const body = JSON.parse(response.body);
  assert.equal(body.projectName, "Project");
  assert.equal(JSON.stringify(body).includes("secret"), false);
  assert.equal(JSON.stringify(body).includes("private"), false);
});

test("keeps workspace data unavailable until native approval exists", async () => {
  const bridge = new bridgeModule.WorkspacePanelBridge({
    context: { threadId: "thread", title: "Panel", projectDir: "/project" },
    openResult: { accessState: "confirmation_required", authorizationSource: "confirmation-required" },
    nativeClient: { session: null },
  });
  const response = await bridge.handle({ method: "GET", route: "/api/workspace" });
  assert.equal(response.status, 409);
  assert.equal(JSON.parse(response.body).accessState, "confirmation_required");
});

test("forwards bounded approved workspace operations and rejects oversized input", async () => {
  const calls = [];
  const nativeClient = {
    session: { workspaceId: "private", accessToken: "secret" },
    async loadWorkspace() { calls.push("load"); return { assets: [], board: { rev: 0 } }; },
    async readAsset(relPath) { calls.push(["asset", relPath]); return { relPath, dataBase64: "cG5n" }; },
    async saveBoard(board) { calls.push(["save", board.baseRev]); return { board: { ...board, rev: board.baseRev + 1 } }; },
    async selection() { calls.push("selection"); return { selected: [] }; },
  };
  const bridge = new bridgeModule.WorkspacePanelBridge({
    context: { threadId: "thread", title: "Panel", projectDir: "/project" },
    openResult: { accessState: "approved", authorizationSource: "previous-approval" },
    nativeClient,
    maxRequestBytes: 256,
  });
  assert.equal((await bridge.handle({ method: "GET", route: "/api/workspace" })).status, 200);
  assert.equal((await bridge.handle({ method: "POST", route: "/api/asset/read", body: JSON.stringify({ relPath: "images/a.png" }) })).status, 200);
  assert.equal((await bridge.handle({ method: "POST", route: "/api/board/save", body: JSON.stringify({ baseRev: 0, viewport: {}, nodes: [], selectedIds: [] }) })).status, 200);
  assert.equal((await bridge.handle({ method: "GET", route: "/api/selection" })).status, 200);
  assert.equal((await bridge.handle({ method: "POST", route: "/api/asset/read", body: "x".repeat(257) })).status, 413);
  assert.deepEqual(calls, ["load", ["asset", "images/a.png"], ["save", 0], "selection"]);
});
