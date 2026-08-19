import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { inlineWidget, readText, registerWidgetResource } from "./lib/widget-resource.mjs";
import {
  approveProjectAccessRequest,
  readWorkspaceAsset,
  readWorkspaceBoard,
  registerWorkspace,
  rememberProjectAccessRequest,
  reopenApprovedWorkspace,
  resolveWorkspace,
  saveWorkspaceBoard,
  scanWorkspaceAssets,
  selectedWorkspaceAssets,
  validateProjectRoot,
} from "./lib/workspace-store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(path.join(ROOT, ".codex-plugin", "plugin.json"), "utf8"));
const WIDGET_URI = "ui://widget/visual-workspace/canvas.html";
const displayModeSchema = z.enum(["fullscreen", "inline", "pip"]);
const workspaceIdSchema = z.string().length(24).regex(/^[a-f0-9]+$/);
const relativePathSchema = z.string().trim().min(1).max(4096);
const capabilityTokenSchema = z.string().min(40).max(128).regex(/^[A-Za-z0-9_-]+$/);
const displayReceiptIdSchema = z.string().min(40).max(128).regex(/^[A-Za-z0-9_-]+$/);
const DISPLAY_RECEIPT_TTL_MS = 30 * 60 * 1000;
const MAX_DISPLAY_RECEIPTS = 512;
const ACCESS_SESSION_IDLE_TTL_MS = 2 * 60 * 60 * 1000;
const ACCESS_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const workspaceSessions = new Map();
const displayReceipts = new Map();

const server = new McpServer({ name: manifest.name, version: manifest.version }, {
  instructions: "Open the native Visual Workspace only after the user asks for it and pass the active workspace absolute path. A project approved once in the widget can reopen directly, including validated Codex worktrees linked to the same Git repository. An unrelated project still requires its own first approval.",
});

function opaqueToken() {
  return randomBytes(32).toString("base64url");
}

function sameDisplayModes(left, right) {
  return left.length === right.length && left.every((mode, index) => mode === right[index]);
}

function purgeExpiredCapabilities() {
  const now = Date.now();
  for (const [token, session] of workspaceSessions) {
    if (now - session.lastUsedAt > ACCESS_SESSION_IDLE_TTL_MS || now - session.createdAt > ACCESS_SESSION_MAX_AGE_MS) {
      workspaceSessions.delete(token);
    }
  }
  for (const [receiptId, receipt] of displayReceipts) {
    if (now - receipt.createdAt > DISPLAY_RECEIPT_TTL_MS) displayReceipts.delete(receiptId);
  }
}

async function optionalClientWorkspaceRoots() {
  if (!server.server.getClientCapabilities()?.roots) return [];
  let response;
  try {
    response = await server.server.listRoots();
  } catch (_error) {
    return [];
  }
  const roots = [];
  for (const root of response.roots || []) {
    try {
      const url = new URL(root.uri);
      if (url.protocol === "file:") roots.push(fileURLToPath(url));
    } catch (_error) {
      // Non-file or malformed roots never widen local access.
    }
  }
  return roots;
}

function issueWorkspaceSession(workspaceId) {
  purgeExpiredCapabilities();
  const accessToken = opaqueToken();
  workspaceSessions.set(accessToken, { workspaceId, createdAt: Date.now(), lastUsedAt: Date.now() });
  return accessToken;
}

async function authorizeWorkspaceSession(workspaceId, accessToken) {
  purgeExpiredCapabilities();
  const session = workspaceSessions.get(accessToken);
  if (!session || session.workspaceId !== workspaceId) {
    throw new Error("Visual Workspace access expired; reopen the plugin and approve this project again");
  }
  session.lastUsedAt = Date.now();
  await resolveWorkspace(workspaceId);
}

function revokeWorkspaceSession(workspaceId, accessToken) {
  purgeExpiredCapabilities();
  const session = workspaceSessions.get(accessToken);
  if (!session || session.workspaceId !== workspaceId) {
    throw new Error("Visual Workspace access is already expired or revoked");
  }
  workspaceSessions.delete(accessToken);
}

registerWidgetResource(server, {
  uri: WIDGET_URI,
  html: async () => inlineWidget({
    html: readText(ROOT, "widget", "index.html"),
    css: readText(ROOT, "widget", "styles.css"),
    js: readText(ROOT, "widget", "app.js"),
    appVersion: manifest.version,
  }),
});

registerAppTool(server, "open_visual_workspace", {
  title: "Open Visual Workspace",
  description: "Open the active project in a native Codex image canvas and request inline, fullscreen, or picture-in-picture display when the host supports it. Call only after the user asks to use Visual Workspace. Previously approved exact projects and validated worktrees from the same Git repository reopen without another confirmation click.",
  inputSchema: {
    projectDir: z.string().trim(),
    displayMode: displayModeSchema.optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  _meta: {
    ui: { resourceUri: WIDGET_URI, visibility: ["model"] },
    "ui/resourceUri": WIDGET_URI,
    "openai/outputTemplate": WIDGET_URI,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": "Opening Visual Workspace…",
    "openai/toolInvocation/invoked": "Visual Workspace ready",
  },
}, async (input) => {
  purgeExpiredCapabilities();
  const projectDir = await validateProjectRoot(input.projectDir);
  const preferredDisplayMode = input.displayMode || "fullscreen";
  const displayReceiptId = opaqueToken();
  while (displayReceipts.size >= MAX_DISPLAY_RECEIPTS) {
    displayReceipts.delete(displayReceipts.keys().next().value);
  }
  displayReceipts.set(displayReceiptId, {
    status: "pending",
    requestedMode: preferredDisplayMode,
    createdAt: Date.now(),
  });
  const hostRoots = await optionalClientWorkspaceRoots();
  let widgetData;
  let authorizationSource;
  if (hostRoots.length) {
    try {
      const workspace = await registerWorkspace({ projectDir, confirmProjectAccess: true, allowedRoots: hostRoots, approvalSource: "host-root" });
      widgetData = { ...workspace, accessToken: issueWorkspaceSession(workspace.workspaceId), accessState: "approved" };
      authorizationSource = "host-root";
    } catch (_error) {
      // A missing/mismatched optional host root falls back to an explicit in-widget user decision.
    }
  }
  if (!widgetData) {
    const workspace = await reopenApprovedWorkspace(projectDir);
    if (workspace) {
      widgetData = { ...workspace, accessToken: issueWorkspaceSession(workspace.workspaceId), accessState: "approved" };
      authorizationSource = "previous-approval";
    }
  }
  if (!widgetData) {
    const accessRequestId = opaqueToken();
    const pendingAccess = await rememberProjectAccessRequest({ accessRequestId, projectDir });
    widgetData = {
      accessState: "confirmation_required",
      accessRequestId,
      accessRequestExpiresAt: pendingAccess.expiresAt,
      projectDir,
      projectName: path.basename(projectDir),
    };
    authorizationSource = "confirmation-required";
  }
  const visibleState = widgetData.accessState;
  return {
    content: [{ type: "text", text: visibleState === "approved" ? "Visual Workspace is ready for the approved project." : "Visual Workspace is ready and is waiting for the user to approve project image access inside the widget." }],
    structuredContent: { preferredDisplayMode, rendering: "native-widget", accessState: visibleState, authorizationSource, displayReceiptId },
    _meta: {
      "openai/outputTemplate": WIDGET_URI,
      widgetData: { ...widgetData, preferredDisplayMode, authorizationSource, displayReceiptId, rendering: "native-widget" },
    },
  };
});

server.registerTool("report_visual_workspace_display_state", {
  title: "Report Visual Workspace Display State",
  description: "Record the initial, one-shot display mode reported after Visual Workspace opens. This app-only diagnostic contains no project path or access token.",
  inputSchema: {
    displayReceiptId: displayReceiptIdSchema,
    requestedMode: displayModeSchema,
    actualMode: displayModeSchema,
    availableModes: z.array(displayModeSchema).max(3),
    outcome: z.enum(["granted", "declined", "unsupported", "error"]),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: WIDGET_URI, visibility: ["app"] } },
}, async ({ displayReceiptId, requestedMode, actualMode, availableModes, outcome }) => {
  purgeExpiredCapabilities();
  const current = displayReceipts.get(displayReceiptId);
  if (!current) throw new Error("Display-mode diagnostic expired; reopen Visual Workspace");
  const normalizedAvailableModes = [...new Set(availableModes)];
  if (requestedMode !== current.requestedMode) {
    throw new Error("Display-mode report does not match the mode requested when Visual Workspace opened");
  }
  if (outcome === "granted" && actualMode !== requestedMode) {
    throw new Error("A granted display-mode report must match the requested mode");
  }
  if ((outcome === "declined" || outcome === "unsupported") && actualMode === requestedMode) {
    throw new Error(`A ${outcome} display-mode report cannot claim the requested mode was granted`);
  }
  if (outcome === "unsupported" && normalizedAvailableModes.includes(requestedMode)) {
    throw new Error("An unsupported display-mode report cannot list the requested mode as available");
  }
  if (current.status === "reported") {
    const duplicate = current.requestedMode === requestedMode
      && current.actualMode === actualMode
      && current.outcome === outcome
      && sameDisplayModes(current.availableModes, normalizedAvailableModes);
    if (!duplicate) throw new Error("Display-mode diagnostic was already finalized for this open request");
    return {
      content: [{ type: "text", text: "The existing display-mode diagnostic already matches this report." }],
      structuredContent: { recorded: true, duplicate: true },
    };
  }
  const receipt = {
    status: "reported",
    requestedMode,
    actualMode,
    availableModes: normalizedAvailableModes,
    outcome,
    createdAt: current.createdAt,
    reportedAt: Date.now(),
  };
  displayReceipts.set(displayReceiptId, receipt);
  return {
    content: [{ type: "text", text: "Codex host display mode was recorded locally for this task." }],
    structuredContent: { recorded: true },
  };
});

server.registerTool("get_visual_workspace_display_receipt", {
  title: "Get Visual Workspace Display Receipt",
  description: "Read the initial, one-shot host-negotiated display-mode result for a Visual Workspace opened in this task.",
  inputSchema: { displayReceiptId: displayReceiptIdSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { visibility: ["model"] } },
}, async ({ displayReceiptId }) => {
  purgeExpiredCapabilities();
  const receipt = displayReceipts.get(displayReceiptId);
  if (!receipt) throw new Error("Display-mode diagnostic expired; reopen Visual Workspace");
  const publicReceipt = {
    status: receipt.status,
    requestedMode: receipt.requestedMode,
    ...(receipt.status === "reported" ? {
      actualMode: receipt.actualMode,
      availableModes: receipt.availableModes,
      outcome: receipt.outcome,
      reportedAt: new Date(receipt.reportedAt).toISOString(),
    } : {}),
  };
  return {
    content: [{ type: "text", text: receipt.status !== "reported"
      ? "Visual Workspace has not reported the host display-mode result yet."
      : receipt.outcome === "granted"
        ? `Codex granted ${receipt.actualMode} after Visual Workspace requested ${receipt.requestedMode}.`
        : receipt.outcome === "declined"
          ? `Codex kept ${receipt.actualMode} and declined the ${receipt.requestedMode} request.`
          : receipt.outcome === "unsupported"
            ? `Codex did not offer ${receipt.requestedMode}; Visual Workspace remained ${receipt.actualMode}.`
            : `The ${receipt.requestedMode} request failed; Visual Workspace remained ${receipt.actualMode}.` }],
    structuredContent: publicReceipt,
  };
});

server.registerTool("approve_visual_workspace_access", {
  title: "Approve Visual Workspace Project Access",
  description: "Approve the exact project shown in the Visual Workspace consent screen. This app-only tool must be called only from the user's button click.",
  inputSchema: { accessRequestId: capabilityTokenSchema },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: WIDGET_URI, visibility: ["app"] } },
}, async ({ accessRequestId }) => {
  const workspace = await approveProjectAccessRequest(accessRequestId);
  return {
    content: [{ type: "text", text: "Project access approved from the Visual Workspace user interface." }],
    structuredContent: {
      ...workspace,
      accessToken: issueWorkspaceSession(workspace.workspaceId),
      accessState: "approved",
    },
  };
});

server.registerTool("revoke_visual_workspace_access", {
  title: "Revoke Visual Workspace Project Access",
  description: "Revoke the current in-memory Visual Workspace session capability when the native widget closes.",
  inputSchema: { workspaceId: workspaceIdSchema, accessToken: capabilityTokenSchema },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: WIDGET_URI, visibility: ["app"] } },
}, async ({ workspaceId, accessToken }) => {
  revokeWorkspaceSession(workspaceId, accessToken);
  return {
    content: [{ type: "text", text: "Visual Workspace project access was revoked for this widget session." }],
    structuredContent: { revoked: true },
  };
});

server.registerTool("get_visual_workspace", {
  title: "Get Visual Workspace",
  description: "Read approved project image metadata and the saved canvas state.",
  inputSchema: { workspaceId: workspaceIdSchema, accessToken: capabilityTokenSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: WIDGET_URI, visibility: ["app"] } },
}, async ({ workspaceId, accessToken }) => {
  await authorizeWorkspaceSession(workspaceId, accessToken);
  const [catalog, board] = await Promise.all([scanWorkspaceAssets(workspaceId), readWorkspaceBoard(workspaceId)]);
  return {
    content: [{ type: "text", text: `Loaded ${catalog.assets.length} project images and ${board.nodes.length} canvas nodes.` }],
    structuredContent: { ...catalog, board },
  };
});

server.registerTool("read_visual_workspace_asset", {
  title: "Read Visual Workspace Image",
  description: "Read one approved project image for display in the native widget.",
  inputSchema: { workspaceId: workspaceIdSchema, accessToken: capabilityTokenSchema, relPath: relativePathSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: WIDGET_URI, visibility: ["app"] } },
}, async (input) => {
  await authorizeWorkspaceSession(input.workspaceId, input.accessToken);
  const asset = await readWorkspaceAsset(input);
  return {
    content: [{ type: "text", text: "The requested project image is ready for the native widget." }],
    structuredContent: asset,
  };
});

server.registerTool("save_visual_workspace", {
  title: "Save Visual Workspace",
  description: "Save only the native canvas arrangement and selection; project images are never modified.",
  inputSchema: {
    workspaceId: workspaceIdSchema,
    accessToken: capabilityTokenSchema,
    baseRev: z.number().int().nonnegative(),
    viewport: z.object({ x: z.number(), y: z.number(), scale: z.number() }),
    nodes: z.array(z.record(z.string(), z.unknown())).max(300),
    selectedIds: z.array(z.string().max(100)).max(300),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: WIDGET_URI, visibility: ["app"] } },
}, async (input) => {
  await authorizeWorkspaceSession(input.workspaceId, input.accessToken);
  let board;
  try {
    board = await saveWorkspaceBoard(input);
  } catch (error) {
    if (error?.code === "REVISION_CONFLICT") {
      return {
        content: [{ type: "text", text: "Visual Workspace changed in another task. Reload before saving again." }],
        structuredContent: { conflict: true, currentBoard: error.current },
      };
    }
    throw error;
  }
  return {
    content: [{ type: "text", text: `Saved Visual Workspace revision ${board.rev}.` }],
    structuredContent: { board },
  };
});

server.registerTool("get_visual_workspace_selection", {
  title: "Get Visual Workspace Selection",
  description: "Return the project-local image paths currently selected in the native canvas.",
  inputSchema: { workspaceId: workspaceIdSchema, accessToken: capabilityTokenSchema },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: WIDGET_URI, visibility: ["app"] } },
}, async ({ workspaceId, accessToken }) => {
  await authorizeWorkspaceSession(workspaceId, accessToken);
  const result = await selectedWorkspaceAssets(workspaceId);
  return {
    content: [{ type: "text", text: result.selected.length ? `${result.selected.length} project image selection record(s) are available as untrusted structured data.` : "No images are selected in Visual Workspace." }],
    structuredContent: result,
  };
});

await server.connect(new StdioServerTransport());
