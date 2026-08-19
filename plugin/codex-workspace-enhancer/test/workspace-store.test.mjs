import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rename as fsRename, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);

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

test("one approved Git project reopens its linked Codex worktrees without another click", async () => {
  assert.equal(typeof store.reopenApprovedWorkspace, "function", "approved Git-worktree lookup is missing");
  const project = await fixture("approved-git-project");
  await execFile("git", ["init", "-b", "main", project]);
  await execFile("git", ["-C", project, "config", "user.email", "visual-workspace@example.invalid"]);
  await execFile("git", ["-C", project, "config", "user.name", "Visual Workspace QA"]);
  await execFile("git", ["-C", project, "add", "."]);
  await execFile("git", ["-C", project, "commit", "-m", "fixture"]);
  const linkedWorktree = path.join(temporary, "approved-git-worktree");
  await execFile("git", ["-C", project, "worktree", "add", "-b", "visual-workspace-test", linkedWorktree]);

  assert.equal(await store.reopenApprovedWorkspace(linkedWorktree), null);
  await store.registerWorkspace({ projectDir: project, confirmProjectAccess: true, allowedRoots: [project], approvalSource: "host-root" });
  assert.equal(await store.reopenApprovedWorkspace(project), null);
  assert.equal(await store.reopenApprovedWorkspace(linkedWorktree), null);
  await store.registerWorkspace({ projectDir: project, confirmProjectAccess: true, allowedRoots: [project], approvalSource: "widget-approval" });
  const reopened = await store.reopenApprovedWorkspace(linkedWorktree);
  assert.equal(reopened.projectRoot, await realpath(linkedWorktree));
  await assert.doesNotReject(store.resolveWorkspace(reopened.workspaceId));

  const unrelated = await fixture("unrelated-git-project");
  await execFile("git", ["init", "-b", "main", unrelated]);
  assert.equal(await store.reopenApprovedWorkspace(unrelated), null);
});

test("pending project access survives a server restart and remains single-use", async () => {
  assert.equal(typeof store.rememberProjectAccessRequest, "function", "durable access-request storage is missing");
  assert.equal(typeof store.consumeProjectAccessRequest, "function", "durable access-request consumption is missing");
  const project = await fixture("durable-consent");
  const accessRequestId = "r".repeat(43);
  await store.rememberProjectAccessRequest({ accessRequestId, projectDir: project });

  const reloadedStore = await import(`../mcp/lib/workspace-store.mjs?restart=${Date.now()}`);
  const results = await Promise.allSettled([
    store.consumeProjectAccessRequest(accessRequestId),
    reloadedStore.consumeProjectAccessRequest(accessRequestId),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "fulfilled")?.value, await realpath(project));
  await assert.rejects(reloadedStore.consumeProjectAccessRequest(accessRequestId), /expired/);

  const expiredRequestId = "e".repeat(43);
  await store.rememberProjectAccessRequest({ accessRequestId: expiredRequestId, projectDir: project });
  const requestFile = path.join(process.env.CODEX_WORKSPACE_ENHANCER_STATE_ROOT, "access-requests.json");
  const requestState = JSON.parse(await readFile(requestFile, "utf8"));
  requestState.requests.find((request) => request.accessRequestId === expiredRequestId).expiresAt = 0;
  await writeFile(requestFile, `${JSON.stringify(requestState)}\n`);
  await assert.rejects(reloadedStore.consumeProjectAccessRequest(expiredRequestId), /expired/);
  await assert.rejects(store.rememberProjectAccessRequest({ accessRequestId: "short", projectDir: project }), /Invalid/);

  const retryableRequestId = "t".repeat(43);
  await store.rememberProjectAccessRequest({ accessRequestId: retryableRequestId, projectDir: project });
  const unavailableProject = `${project}.temporarily-unavailable`;
  await fsRename(project, unavailableProject);
  try {
    await assert.rejects(store.consumeProjectAccessRequest(retryableRequestId), /ENOENT/);
  } finally {
    await fsRename(unavailableProject, project);
  }
  assert.equal(await store.consumeProjectAccessRequest(retryableRequestId), await realpath(project));
});

test("pending project access is consumed once across independent processes and recovers an abandoned claim", async () => {
  const project = await fixture("cross-process-consent");
  const accessRequestId = "p".repeat(43);
  await store.rememberProjectAccessRequest({ accessRequestId, projectDir: project });
  const moduleUrl = new URL("../mcp/lib/workspace-store.mjs", import.meta.url).href;
  const childScript = `
    import { consumeProjectAccessRequest } from ${JSON.stringify(moduleUrl)};
    const result = await consumeProjectAccessRequest(${JSON.stringify(accessRequestId)});
    process.stdout.write(result);
  `;
  const consumers = await Promise.allSettled([
    execFile("node", ["--input-type=module", "--eval", childScript], { env: { ...process.env } }),
    execFile("node", ["--input-type=module", "--eval", childScript], { env: { ...process.env } }),
  ]);
  assert.equal(consumers.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(consumers.find((result) => result.status === "fulfilled")?.value.stdout, await realpath(project));

  const abandonedRequestId = "a".repeat(43);
  await store.rememberProjectAccessRequest({ accessRequestId: abandonedRequestId, projectDir: project });
  const stateRoot = process.env.CODEX_WORKSPACE_ENHANCER_STATE_ROOT;
  const stateFile = path.join(stateRoot, "access-requests.json");
  const abandonedClaim = path.join(stateRoot, ".access-requests.claim-2147483647-00000000-0000-4000-8000-000000000000.json");
  await fsRename(stateFile, abandonedClaim);
  const staleTime = new Date(Date.now() - 31_000);
  await utimes(abandonedClaim, staleTime, staleTime);
  assert.equal(await store.consumeProjectAccessRequest(abandonedRequestId), await realpath(project));
});

test("widget approval keeps its request retryable until catalog registration commits", async () => {
  assert.equal(typeof store.approveProjectAccessRequest, "function", "transactional widget approval is missing");
  const project = await fixture("approval-transaction");
  const accessRequestId = "w".repeat(43);
  await store.rememberProjectAccessRequest({ accessRequestId, projectDir: project });
  const catalogFile = path.join(process.env.CODEX_WORKSPACE_ENHANCER_STATE_ROOT, "workspaces.json");
  const catalogBefore = await readFile(catalogFile, "utf8");
  await writeFile(catalogFile, "{invalid json\n");
  try {
    await assert.rejects(store.approveProjectAccessRequest(accessRequestId), /invalid/);
  } finally {
    await writeFile(catalogFile, catalogBefore);
  }
  const approved = await store.approveProjectAccessRequest(accessRequestId);
  assert.equal(approved.projectRoot, await realpath(project));
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
