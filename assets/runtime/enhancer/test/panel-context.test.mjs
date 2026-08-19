import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const implementation = await import("../lib/panel-context.mjs").catch(() => ({}));
const temporary = await mkdtemp(path.join(os.tmpdir(), "panel-context-test-"));

test.after(async () => rm(temporary, { recursive: true, force: true }));

test("exports a panel context resolver", () => {
  assert.equal(typeof implementation.resolvePanelContext, "function", "resolvePanelContext is missing");
});

test("resolves the exact project cwd from session metadata", async () => {
  const codexHome = path.join(temporary, "codex-home");
  const projectDir = path.join(temporary, "project");
  const threadId = "01234567-89ab-cdef-0123-456789abcdef";
  await mkdir(path.join(codexHome, "sessions", "2026", "08", "19"), { recursive: true });
  await mkdir(projectDir);
  await writeFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: threadId, thread_name: "Panel", updated_at: new Date().toISOString() })}\n`);
  await writeFile(path.join(codexHome, "sessions", "2026", "08", "19", `rollout-${threadId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: projectDir } })}\n`);
  const context = await implementation.resolvePanelContext({ codexHome, threadId });
  assert.equal(context.threadId, threadId);
  assert.equal(context.projectDir, await import("node:fs/promises").then(({ realpath }) => realpath(projectDir)));
});

test("rejects missing and broad project roots", async () => {
  const codexHome = path.join(temporary, "broad-home");
  const threadId = "fedcba98-7654-3210-fedc-ba9876543210";
  await mkdir(path.join(codexHome, "sessions"), { recursive: true });
  await writeFile(path.join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: threadId, thread_name: "Broad", updated_at: new Date().toISOString() })}\n`);
  await writeFile(path.join(codexHome, "sessions", `rollout-${threadId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: os.homedir() } })}\n`);
  assert.equal(await implementation.resolvePanelContext({ codexHome, threadId }), null);
  assert.equal(await implementation.resolvePanelContext({ codexHome, threadId: "00000000-0000-0000-0000-000000000000" }), null);
});

test("rejects a symlink project root from session metadata", async () => {
  const codexHome = path.join(temporary, "symlink-home");
  const projectDir = path.join(temporary, "real-project");
  const projectLink = path.join(temporary, "project-link");
  const threadId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  await mkdir(path.join(codexHome, "sessions"), { recursive: true });
  await mkdir(projectDir);
  await symlink(projectDir, projectLink);
  await writeFile(path.join(codexHome, "sessions", `rollout-${threadId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: projectLink } })}\n`);
  assert.equal(await implementation.resolvePanelContext({ codexHome, threadId }), null);
});

test("normalizes bounded Git and worktree state for the current task", async () => {
  const codexHome = path.join(temporary, "git-home");
  const projectDir = path.join(temporary, "git-project");
  const threadId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  await mkdir(path.join(codexHome, "sessions"), { recursive: true });
  await mkdir(projectDir);
  await execFileAsync("git", ["init", "-b", "feature/panel"], { cwd: projectDir });
  await execFileAsync("git", ["config", "user.name", "Panel Test"], { cwd: projectDir });
  await execFileAsync("git", ["config", "user.email", "panel@example.invalid"], { cwd: projectDir });
  await writeFile(path.join(projectDir, "tracked.txt"), "base\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: projectDir });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: projectDir });
  await writeFile(path.join(projectDir, "tracked.txt"), "changed\n");
  await writeFile(path.join(projectDir, "new.txt"), "new\n");
  await writeFile(path.join(codexHome, "sessions", `rollout-${threadId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: projectDir } })}\n`);
  const context = await implementation.resolvePanelContext({ codexHome, threadId });
  assert.equal(context.worktreeRoot, await import("node:fs/promises").then(({ realpath }) => realpath(projectDir)));
  assert.equal(context.git.branch, "feature/panel");
  assert.equal(context.git.dirtyCount, 2);
  assert.deepEqual(context.git.paths, ["new.txt", "tracked.txt"]);
  assert.equal(context.git.ahead, 0);
  assert.equal(context.git.behind, 0);
});
