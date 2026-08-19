import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ENTRIES = 20_000;
const MAX_DEPTH = 7;

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
  return {
    threadId: threadId.toLowerCase(),
    title: await threadTitle(codexHome, threadId),
    projectDir,
    sessionFile: file,
  };
}
