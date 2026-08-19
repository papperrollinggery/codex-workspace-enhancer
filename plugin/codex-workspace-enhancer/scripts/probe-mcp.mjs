import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const temporary = await mkdtemp(path.join(tmpdir(), "visual-workspace-probe-"));
const serverOption = process.argv.indexOf("--server");
const serverEntry = serverOption >= 0 ? path.resolve(process.argv[serverOption + 1] || "") : "./scripts/start-mcp.mjs";
if (!serverEntry) throw new Error("--server requires a path");
const projectDir = path.join(temporary, "project");
const directProjectDir = path.join(temporary, "direct-project");
const stateRoot = path.join(temporary, "state");
await mkdir(path.join(projectDir, "references"), { recursive: true });
await mkdir(path.join(directProjectDir, "references"), { recursive: true });
const imagePath = path.join(projectDir, "references", "probe.png");
await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"));
await writeFile(path.join(directProjectDir, "references", "direct.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"));

const transport = new StdioClientTransport({
  command: "node",
  args: [serverEntry],
  env: { ...process.env, CODEX_WORKSPACE_ENHANCER_STATE_ROOT: stateRoot },
});
const client = new Client(
  { name: "visual-workspace-probe", version: "0.1.0" },
  { capabilities: {} },
);
let rootedClient;

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const required of [
    "open_visual_workspace",
    "report_visual_workspace_display_state",
    "get_visual_workspace_display_receipt",
    "approve_visual_workspace_access",
    "revoke_visual_workspace_access",
    "get_visual_workspace",
    "read_visual_workspace_asset",
    "save_visual_workspace",
    "get_visual_workspace_selection",
  ]) {
    if (!names.has(required)) throw new Error(`Missing MCP tool: ${required}`);
  }
  const visibility = Object.fromEntries(tools.tools.map((tool) => [tool.name, tool._meta?.ui?.visibility]));
  if (JSON.stringify(visibility.open_visual_workspace) !== JSON.stringify(["model"])) {
    throw new Error("Open tool must be model-visible and host-gated");
  }
  if (JSON.stringify(visibility.get_visual_workspace_display_receipt) !== JSON.stringify(["model"])) {
    throw new Error("Display receipt reader must be model-visible");
  }
  for (const appOnly of ["approve_visual_workspace_access", "report_visual_workspace_display_state", "revoke_visual_workspace_access", "get_visual_workspace", "read_visual_workspace_asset", "save_visual_workspace", "get_visual_workspace_selection"]) {
    if (JSON.stringify(visibility[appOnly]) !== JSON.stringify(["app"])) {
      throw new Error(`${appOnly} must be app-only`);
    }
  }
  const denied = await client.callTool({
    name: "open_visual_workspace",
    arguments: { projectDir: path.parse(projectDir).root },
  });
  if (!denied.isError) throw new Error("Visual Workspace must reject broad filesystem roots");

  const opened = await client.callTool({
    name: "open_visual_workspace",
    arguments: { projectDir },
  });
  if (opened._meta?.["openai/outputTemplate"] !== "ui://widget/visual-workspace/canvas.html") {
    throw new Error("Open tool did not return native widget metadata");
  }
  if (opened.structuredContent?.workspaceId || opened.structuredContent?.accessRequestId || opened.structuredContent?.projectDir) {
    throw new Error("Open tool exposed local project capabilities to the model");
  }
  if (opened.structuredContent?.accessState !== "confirmation_required") throw new Error("Rootless host must receive an in-widget access gate");
  if (opened.structuredContent?.authorizationSource !== "confirmation-required") throw new Error("Rootless first approval reported the wrong authorization source");
  if (opened.structuredContent?.preferredDisplayMode !== "fullscreen") throw new Error("Visual Workspace must default to fullscreen");
  const displayReceiptId = opened.structuredContent?.displayReceiptId;
  if (!displayReceiptId) throw new Error("Open tool did not return a display-mode diagnostic receipt id");
  const pendingDisplay = await client.callTool({ name: "get_visual_workspace_display_receipt", arguments: { displayReceiptId } });
  if (pendingDisplay.structuredContent?.status !== "pending") throw new Error("Display-mode diagnostic did not begin pending");
  await client.callTool({
    name: "report_visual_workspace_display_state",
    arguments: { displayReceiptId, requestedMode: "fullscreen", actualMode: "inline", availableModes: ["inline"], outcome: "unsupported" },
  });
  const reportedDisplay = await client.callTool({ name: "get_visual_workspace_display_receipt", arguments: { displayReceiptId } });
  if (reportedDisplay.structuredContent?.actualMode !== "inline" || reportedDisplay.structuredContent?.outcome !== "unsupported") {
    throw new Error("Display-mode diagnostic did not return the app-reported host result");
  }
  const duplicateDisplay = await client.callTool({
    name: "report_visual_workspace_display_state",
    arguments: { displayReceiptId, requestedMode: "fullscreen", actualMode: "inline", availableModes: ["inline"], outcome: "unsupported" },
  });
  if (duplicateDisplay.isError || duplicateDisplay.structuredContent?.duplicate !== true) {
    throw new Error("Display-mode diagnostic did not accept an idempotent duplicate report");
  }
  const contradictoryDisplay = await client.callTool({
    name: "report_visual_workspace_display_state",
    arguments: { displayReceiptId, requestedMode: "fullscreen", actualMode: "fullscreen", availableModes: ["inline", "fullscreen"], outcome: "granted" },
  });
  if (!contradictoryDisplay.isError) throw new Error("Display-mode diagnostic allowed a finalized receipt to be overwritten");
  const accessRequestId = opened._meta?.widgetData?.accessRequestId;
  if (!accessRequestId) throw new Error("Widget did not receive its private access request capability");
  const concurrentApprovals = await Promise.all([
    client.callTool({ name: "approve_visual_workspace_access", arguments: { accessRequestId } }),
    client.callTool({ name: "approve_visual_workspace_access", arguments: { accessRequestId } }),
  ]);
  const successfulApprovals = concurrentApprovals.filter((result) => !result.isError);
  if (successfulApprovals.length !== 1) throw new Error("Project approval capability was not atomically single-use");
  const approved = successfulApprovals[0];
  const workspaceId = approved.structuredContent?.workspaceId;
  const accessToken = approved.structuredContent?.accessToken;
  if (!workspaceId || !accessToken) throw new Error("In-widget project approval did not issue a session capability");

  const reopened = await client.callTool({
    name: "open_visual_workspace",
    arguments: { projectDir, displayMode: "fullscreen" },
  });
  if (reopened.structuredContent?.accessState !== "approved") {
    throw new Error("A previously approved exact project required another confirmation click");
  }
  if (reopened.structuredContent?.authorizationSource !== "previous-approval") {
    throw new Error("Reopened project reported the wrong authorization source");
  }
  if (!reopened.content?.some((item) => item.type === "text" && item.text === "Visual Workspace is ready for the approved project.")) {
    throw new Error("Reopened project was mislabeled as host-approved");
  }
  if (!reopened._meta?.widgetData?.workspaceId || !reopened._meta?.widgetData?.accessToken) {
    throw new Error("Reopened project did not issue a private widget session capability");
  }
  if (reopened.structuredContent?.workspaceId || reopened.structuredContent?.accessToken || reopened.structuredContent?.projectDir) {
    throw new Error("Reopened project exposed project capabilities to the model");
  }
  const unknownOpen = await client.callTool({
    name: "open_visual_workspace",
    arguments: { projectDir: directProjectDir, displayMode: "fullscreen" },
  });
  if (unknownOpen.structuredContent?.accessState !== "confirmation_required") {
    throw new Error("An unrelated project bypassed the first-time confirmation gate");
  }

  const unauthorized = await client.callTool({
    name: "get_visual_workspace",
    arguments: { workspaceId, accessToken: "x".repeat(43) },
  });
  if (!unauthorized.isError) throw new Error("Workspace reads must reject an invalid session capability");

  const loaded = await client.callTool({ name: "get_visual_workspace", arguments: { workspaceId, accessToken } });
  if (loaded.structuredContent?.assets?.[0]?.relPath !== "references/probe.png") throw new Error("Project image scan failed");
  if (loaded.structuredContent?.board?.rev !== 0) throw new Error("Fresh canvas should start at revision 0");

  const read = await client.callTool({
    name: "read_visual_workspace_asset",
    arguments: { workspaceId, accessToken, relPath: "references/probe.png" },
  });
  if (read.structuredContent?.mimeType !== "image/png" || !read.structuredContent?.dataBase64) throw new Error("Image preview tool failed");

  const saved = await client.callTool({
    name: "save_visual_workspace",
    arguments: {
      workspaceId,
      accessToken,
      baseRev: 0,
      viewport: { x: 40, y: 30, scale: 1.2 },
      nodes: [{ id: "asset-probe", kind: "asset", x: 10, y: 20, width: 320, height: 220, z: 0, relPath: "references/probe.png", label: "Probe" }],
      selectedIds: ["asset-probe"],
    },
  });
  if (saved.structuredContent?.board?.rev !== 1) throw new Error("Canvas save did not advance revision");

  const conflict = await client.callTool({
    name: "save_visual_workspace",
    arguments: {
      workspaceId,
      accessToken,
      baseRev: 0,
      viewport: { x: 0, y: 0, scale: 1 },
      nodes: [],
      selectedIds: [],
    },
  });
  if (conflict.structuredContent?.conflict !== true || conflict.structuredContent?.currentBoard?.rev !== 1) {
    throw new Error("Revision conflict did not return a structured, recoverable result");
  }

  const selection = await client.callTool({ name: "get_visual_workspace_selection", arguments: { workspaceId, accessToken } });
  if (selection.structuredContent?.selected?.[0]?.absolutePath !== await realpath(imagePath)) throw new Error("Canvas selection handoff failed");

  const resource = await client.readResource({ uri: "ui://widget/visual-workspace/canvas.html" });
  const contents = resource.contents?.[0];
  if (!String(contents?.mimeType).includes("mcp-app")) throw new Error("Widget resource has the wrong MIME type");
  if (!contents?.text?.includes("window.visualWorkspaceMcp") || !contents.text.includes("Visual Workspace")) throw new Error("Widget host bridge was not inlined");
  if (/<script\b[^>]*\btype=["']module/i.test(contents.text) || /<script\b[^>]+\bsrc=/i.test(contents.text)) throw new Error("Widget must be a direct static document without external scripts");
  const csp = contents._meta?.["openai/widgetCSP"];
  if (!csp?.resource_domains?.includes("blob:")) throw new Error("Widget CSP must allow in-memory image previews");

  const persisted = JSON.parse(await readFile(path.join(stateRoot, `${workspaceId}.canvas.json`), "utf8"));
  if (persisted.rev !== 1) throw new Error("Canvas state was not persisted to the isolated state root");
  const movedProjectDir = `${projectDir}.temporarily-unavailable`;
  await rename(projectDir, movedProjectDir);
  let revoked;
  try {
    revoked = await client.callTool({ name: "revoke_visual_workspace_access", arguments: { workspaceId, accessToken } });
  } finally {
    await rename(movedProjectDir, projectDir);
  }
  if (revoked.structuredContent?.revoked !== true) throw new Error("Widget teardown could not revoke its session capability");
  const afterRevoke = await client.callTool({ name: "get_visual_workspace", arguments: { workspaceId, accessToken } });
  if (!afterRevoke.isError) throw new Error("Revoked workspace capability remained usable");

  const rootedTransport = new StdioClientTransport({
    command: "node",
    args: [serverEntry],
    env: { ...process.env, CODEX_WORKSPACE_ENHANCER_STATE_ROOT: stateRoot },
  });
  rootedClient = new Client(
    { name: "visual-workspace-roots-probe", version: "0.1.0" },
    { capabilities: { roots: {} } },
  );
  rootedClient.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(projectDir).href, name: "Probe project" }],
  }));
  await rootedClient.connect(rootedTransport);
  const rootedOpen = await rootedClient.callTool({ name: "open_visual_workspace", arguments: { projectDir } });
  if (rootedOpen.structuredContent?.accessState !== "approved") throw new Error("Host-approved roots did not authorize the matching project");
  if (rootedOpen.structuredContent?.authorizationSource !== "host-root") throw new Error("Host-root open reported the wrong authorization source");
  if (rootedOpen.structuredContent?.workspaceId || rootedOpen.structuredContent?.accessToken || rootedOpen.structuredContent?.projectDir) {
    throw new Error("Host-approved open exposed project capabilities to the model");
  }
  const rootedWorkspaceId = rootedOpen._meta?.widgetData?.workspaceId;
  const rootedAccessToken = rootedOpen._meta?.widgetData?.accessToken;
  if (!rootedWorkspaceId || !rootedAccessToken) throw new Error("Host-approved widget did not receive a session capability");
  const rootedLoad = await rootedClient.callTool({
    name: "get_visual_workspace",
    arguments: { workspaceId: rootedWorkspaceId, accessToken: rootedAccessToken },
  });
  if (rootedLoad.isError || rootedLoad.structuredContent?.assets?.length !== 1) throw new Error("Host-approved session could not read the project catalog");
  await rootedClient.callTool({
    name: "revoke_visual_workspace_access",
    arguments: { workspaceId: rootedWorkspaceId, accessToken: rootedAccessToken },
  });
  console.log("OK: rootless and host-root Codex clients keep capabilities model-hidden; display receipts, consent, single-use approval, teardown revocation, preview, save, and selection handoff are available.");
} finally {
  await rootedClient?.close().catch(() => {});
  await client.close().catch(() => {});
  await rm(temporary, { recursive: true, force: true });
}
