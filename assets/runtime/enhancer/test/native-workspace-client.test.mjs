import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const temporary = await mkdtemp(path.join(os.tmpdir(), "native-workspace-client-test-"));
const stateRoot = path.join(temporary, "state");
process.env.CODEX_WORKSPACE_ENHANCER_STATE_ROOT = stateRoot;
const directory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(directory, "../../../../plugin/codex-workspace-enhancer");
const serverEntry = path.join(pluginRoot, "mcp", "server.mjs");
const store = await import(`../../../../plugin/codex-workspace-enhancer/mcp/lib/workspace-store.mjs?panel=${Date.now()}`);
const implementation = await import("../lib/native-workspace-client.mjs").catch(() => ({}));

test.after(async () => rm(temporary, { recursive: true, force: true }));

async function projectFixture(name) {
  const projectDir = path.join(temporary, name);
  await mkdir(path.join(projectDir, "images"), { recursive: true });
  await writeFile(path.join(projectDir, "images", "one.png"), "png");
  return projectDir;
}

test("exports native workspace discovery and session clients", () => {
  assert.equal(typeof implementation.discoverInstalledVisualWorkspace, "function", "installed plugin discovery is missing");
  assert.equal(typeof implementation.NativeWorkspaceClient, "function", "NativeWorkspaceClient is missing");
});

test("discovers a regular installed server and rejects a symlink entry", async () => {
  const regular = await implementation.discoverInstalledVisualWorkspace({ explicitServerPath: path.join(pluginRoot, "dist", "server.mjs") });
  assert.equal(regular.version, "0.2.2");
  const symlinkPath = path.join(pluginRoot, "dist", "panel-test-server-link.mjs");
  await symlink(path.join(pluginRoot, "dist", "server.mjs"), symlinkPath);
  try {
    await assert.rejects(implementation.discoverInstalledVisualWorkspace({ explicitServerPath: symlinkPath }), /regular file/i);
  } finally {
    await rm(symlinkPath, { force: true });
  }
});

test("opens an approved project and reuses native workspace tools", async () => {
  const projectDir = await projectFixture("approved");
  await store.registerWorkspace({
    projectDir,
    confirmProjectAccess: true,
    allowedRoots: [projectDir],
    approvalSource: "widget-approval",
  });
  const client = new implementation.NativeWorkspaceClient({
    serverEntry,
    pluginRoot,
    env: { ...process.env, CODEX_WORKSPACE_ENHANCER_STATE_ROOT: stateRoot },
  });
  const opened = await client.openApprovedWorkspace({ projectDir });
  assert.equal(opened.accessState, "approved");
  assert.equal(opened.authorizationSource, "previous-approval");
  assert.equal("accessToken" in opened, false);
  assert.ok(client.session?.workspaceId);
  assert.ok(client.session?.accessToken);
  const workspace = await client.loadWorkspace();
  assert.equal(workspace.assets[0].relPath, "images/one.png");
  const asset = await client.readAsset("images/one.png");
  assert.equal(asset.dataBase64, Buffer.from("png").toString("base64"));
  await client.close();
});

test("does not approve an unrelated project", async () => {
  const projectDir = await projectFixture("unapproved");
  const client = new implementation.NativeWorkspaceClient({
    serverEntry,
    pluginRoot,
    env: { ...process.env, CODEX_WORKSPACE_ENHANCER_STATE_ROOT: stateRoot },
  });
  const opened = await client.openApprovedWorkspace({ projectDir });
  assert.equal(opened.accessState, "confirmation_required");
  assert.equal(client.session, null);
  await client.close();
});
