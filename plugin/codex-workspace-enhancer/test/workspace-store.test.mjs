import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const temporary = await mkdtemp(path.join(os.tmpdir(), "visual-workspace-store-test-"));
process.env.CODEX_WORKSPACE_ENHANCER_STATE_ROOT = path.join(temporary, "state");
const store = await import(`../mcp/lib/workspace-store.mjs?test=${Date.now()}`);

test.after(async () => {
  await rm(temporary, { recursive: true, force: true });
});

async function fixture(name) {
  const project = path.join(temporary, name);
  await mkdir(path.join(project, "images"), { recursive: true });
  await writeFile(path.join(project, "images", "one.png"), "png");
  return project;
}

test("project registration is explicit and rejects broad roots", async () => {
  const project = await fixture("registration");
  await assert.rejects(store.registerWorkspace({ projectDir: project, confirmProjectAccess: false, allowedRoots: [project] }), /requires confirmProjectAccess/);
  await assert.rejects(store.registerWorkspace({ projectDir: os.homedir(), confirmProjectAccess: true, allowedRoots: [project] }), /Refusing/);
  await assert.rejects(store.registerWorkspace({ projectDir: path.dirname(os.homedir()), confirmProjectAccess: true, allowedRoots: [project] }), /Refusing/);
  await assert.rejects(store.registerWorkspace({ projectDir: project, confirmProjectAccess: true, allowedRoots: [path.join(temporary, "elsewhere")] }), /outside the workspace roots/);
  const registered = await store.registerWorkspace({ projectDir: project, confirmProjectAccess: true, allowedRoots: [project] });
  assert.match(registered.workspaceId, /^[a-f0-9]{24}$/);
  await assert.doesNotReject(store.assertWorkspaceAllowed(registered.workspaceId, [project]));
  await assert.rejects(store.assertWorkspaceAllowed(registered.workspaceId, [path.join(temporary, "elsewhere")]), /outside the roots approved/);
});

test("scanner skips symlink escapes and preview rejects traversal", async () => {
  const project = await fixture("scan-safety");
  const outside = path.join(temporary, "outside");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.png"), "secret");
  await symlink(outside, path.join(project, "images", "external"));
  const { workspaceId } = await store.registerWorkspace({ projectDir: project, confirmProjectAccess: true, allowedRoots: [project] });
  const scanned = await store.scanWorkspaceAssets(workspaceId);
  assert.deepEqual(scanned.assets.map((asset) => asset.relPath), ["images/one.png"]);
  await assert.rejects(store.readWorkspaceAsset({ workspaceId, relPath: "../outside/secret.png" }), /escapes/);
});

test("scanner rejects control-character paths and preview enforces its byte limit", async () => {
  const project = await fixture("preview-limits");
  await writeFile(path.join(project, "images", "unsafe\nname.png"), "unsafe");
  const oversized = path.join(project, "images", "oversized.png");
  await writeFile(oversized, "");
  await truncate(oversized, store.workspaceLimits.maxPreviewBytes + 1);
  const { workspaceId } = await store.registerWorkspace({ projectDir: project, confirmProjectAccess: true, allowedRoots: [project] });
  const scanned = await store.scanWorkspaceAssets(workspaceId);
  assert.equal(scanned.assets.some((asset) => asset.relPath.includes("\n")), false);
  await assert.rejects(store.readWorkspaceAsset({ workspaceId, relPath: "images/unsafe\nname.png" }), /control characters/);
  await assert.rejects(store.readWorkspaceAsset({ workspaceId, relPath: "images/oversized.png" }), /too large to preview/);
});

test("scanner degrades safely when a nested directory is unreadable", { skip: process.platform === "win32" }, async () => {
  const project = await fixture("unreadable-directory");
  const unreadable = path.join(project, "unreadable");
  await mkdir(unreadable);
  await writeFile(path.join(unreadable, "hidden.png"), "hidden");
  await chmod(unreadable, 0o000);
  try {
    const { workspaceId } = await store.registerWorkspace({ projectDir: project, confirmProjectAccess: true, allowedRoots: [project] });
    const scanned = await store.scanWorkspaceAssets(workspaceId);
    assert.equal(scanned.truncated, true);
    assert.deepEqual(scanned.assets.map((asset) => asset.relPath), ["images/one.png"]);
  } finally {
    await chmod(unreadable, 0o700);
  }
});

test("canvas saves atomically with revision conflicts and revalidates assets", async () => {
  const project = await fixture("canvas");
  const { workspaceId } = await store.registerWorkspace({ projectDir: project, confirmProjectAccess: true, allowedRoots: [project] });
  const payload = {
    workspaceId,
    baseRev: 0,
    viewport: { x: 0, y: 0, scale: 1 },
    nodes: [{ id: "asset-one", kind: "asset", x: 0, y: 0, width: 320, height: 220, z: 0, relPath: "images/one.png", label: "One" }],
    selectedIds: ["asset-one"],
  };
  const [left, right] = await Promise.allSettled([
    store.saveWorkspaceBoard(payload),
    store.saveWorkspaceBoard(payload),
  ]);
  assert.equal([left, right].filter((result) => result.status === "fulfilled").length, 1);
  assert.equal([left, right].filter((result) => result.status === "rejected").length, 1);
  assert.equal((await store.readWorkspaceBoard(workspaceId)).rev, 1);
  const selection = await store.selectedWorkspaceAssets(workspaceId);
  assert.equal(selection.selected[0].absolutePath, await realpath(path.join(project, "images", "one.png")));
});

test("canvas rejects unsupported and missing asset references", async () => {
  const project = await fixture("canvas-invalid");
  const { workspaceId } = await store.registerWorkspace({ projectDir: project, confirmProjectAccess: true, allowedRoots: [project] });
  const base = { workspaceId, baseRev: 0, viewport: { x: 0, y: 0, scale: 1 }, selectedIds: [] };
  await assert.rejects(store.saveWorkspaceBoard({ ...base, nodes: [{ id: "bad", kind: "asset", relPath: "notes.txt" }] }), /Unsupported/);
  await assert.rejects(store.saveWorkspaceBoard({ ...base, nodes: [{ id: "missing", kind: "asset", relPath: "images/missing.png" }] }), /ENOENT/);
});
