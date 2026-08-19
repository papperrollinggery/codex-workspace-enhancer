import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 7;
const execFileAsync = promisify(execFile);
const GIT_OPTIONS = { timeout: 3_000, maxBuffer: 1024 * 1024, encoding: "utf8" };

async function gitOutput(projectDir, args) {
  const { stdout } = await execFileAsync("git", args, { cwd: projectDir, ...GIT_OPTIONS });
  return String(stdout || "");
}

async function git(projectDir, args) {
  return (await gitOutput(projectDir, args)).trim();
}

async function readGitContext(projectDir) {
  const worktreeRoot = await git(projectDir, ["rev-parse", "--show-toplevel"]).catch(() => "");
  if (!worktreeRoot) return {
    worktreeRoot: null,
    git: { branch: "", dirtyCount: 0, ahead: 0, behind: 0, paths: [] },
  };
  const [branch, rawStatus, divergence] = await Promise.all([
    git(worktreeRoot, ["branch", "--show-current"]).catch(() => ""),
    gitOutput(worktreeRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).catch(() => ""),
    git(worktreeRoot, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).catch(() => "0\t0"),
  ]);
  const records = rawStatus.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < records.length && paths.length < 500; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    const file = record.slice(3);
    if (file) paths.push(file);
    if (/R|C/u.test(status) && records[index + 1]) index += 1;
  }
  const uniquePaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));
  const [ahead = 0, behind = 0] = divergence.split(/\s+/u).map((value) => Number.parseInt(value, 10) || 0);
  return {
    worktreeRoot: await realpath(worktreeRoot).catch(() => worktreeRoot),
    git: {
      branch,
      dirtyCount: uniquePaths.length,
      ahead,
      behind,
      paths: uniquePaths,
    },
  };
}

function isBroadRoot(value) {
  const root = path.resolve(value);
  const home = path.resolve(os.homedir());
  return [path.parse(root).root, home, path.dirname(home), "/Users", "/Volumes", "/private", "/tmp", "/var"]
    .some((candidate) => path.resolve(candidate) === root);
}

async function validatedProjectDir(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const requested = path.resolve(value);
  if (isBroadRoot(requested)) return null;
  const stats = await lstat(requested).catch(() => null);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) return null;
  const resolved = await realpath(requested).catch(() => null);
  return resolved && !isBroadRoot(resolved) ? resolved : null;
}

async function findSessionFile(root, threadId) {
  let visited = 0;
  async function walk(directory, depth) {
    if (depth > MAX_DEPTH || visited >= MAX_ENTRIES) return null;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      visited += 1;
      if (visited >= MAX_ENTRIES) return null;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await walk(candidate, depth + 1);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.toLowerCase().includes(threadId.toLowerCase())) {
        return candidate;
      }
    }
    return null;
  }
  return walk(root, 0);
}

async function readHead(file, bytes = 256 * 1024) {
  const handle = await open(file, "r");
  try {
    const length = Math.min((await handle.stat()).size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function threadTitle(codexHome, threadId) {
  const index = await readFile(path.join(codexHome, "session_index.jsonl"), "utf8").catch(() => "");
  let selected = null;
  for (const line of index.split("\n")) {
    try {
      const row = JSON.parse(line);
      if (String(row.id).toLowerCase() !== threadId.toLowerCase()) continue;
      const timestamp = Date.parse(row.updated_at || "") || 0;
      if (!selected || timestamp >= selected.timestamp) selected = { title: String(row.thread_name || "").trim(), timestamp };
    } catch {}
  }
  return selected?.title || "";
}

export async function resolvePanelContext({ codexHome = path.join(os.homedir(), ".codex"), threadId } = {}) {
  if (!THREAD_ID.test(String(threadId || ""))) return null;
  const file = await findSessionFile(path.join(codexHome, "sessions"), threadId);
  if (!file) return null;
  const head = await readHead(file).catch(() => "");
  let metadata = null;
  for (const line of head.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session_meta" && String(entry.payload?.id || threadId).toLowerCase() === threadId.toLowerCase()) {
        metadata = entry.payload;
        break;
      }
    } catch {}
  }
  const projectDir = await validatedProjectDir(metadata?.cwd);
  if (!projectDir) return null;
  const gitContext = await readGitContext(projectDir);
  return {
    threadId: threadId.toLowerCase(),
    title: await threadTitle(codexHome, threadId),
    projectDir,
    sessionFile: file,
    ...gitContext,
  };
}
