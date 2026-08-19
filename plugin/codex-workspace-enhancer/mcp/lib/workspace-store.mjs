import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const IMAGE_EXTENSIONS = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".webp", "image/webp"],
]);
const SKIP_DIRECTORIES = new Set([
  ".git", ".svn", ".hg", ".next", ".nuxt", ".cache", ".turbo",
  "node_modules", "dist", "build", "coverage", "__pycache__",
]);
const MAX_ASSETS = 600;
const MAX_DEPTH = 7;
const MAX_SCAN_MS = 3_500;
const MAX_SCAN_ENTRIES = 20_000;
const MAX_PREVIEW_BYTES = 12 * 1024 * 1024;
const MAX_NODES = 300;
const MAX_NOTE_LENGTH = 2_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 8_000;
const ACCESS_REQUEST_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ACCESS_REQUESTS = 512;

function stateRoot() {
  if (process.env.CODEX_WORKSPACE_ENHANCER_STATE_ROOT) {
    return path.resolve(process.env.CODEX_WORKSPACE_ENHANCER_STATE_ROOT);
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"), "CodexWorkspaceEnhancer", "native-plugin");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "CodexWorkspaceEnhancer", "native-plugin");
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "codex-workspace-enhancer", "native-plugin");
}

const ROOT = stateRoot();
const CATALOG_FILE = path.join(ROOT, "workspaces.json");
const ACCESS_REQUESTS_FILE = path.join(ROOT, "access-requests.json");
const CAPABILITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,128}$/;
const APPROVAL_SOURCES = new Set(["host-root", "widget-approval", "inherited-worktree"]);
const PERSISTENT_APPROVAL_SOURCES = new Set(["widget-approval", "inherited-worktree"]);

function workspaceIdFor(root) {
  return createHash("sha256").update(root).digest("hex").slice(0, 24);
}

async function ensureStateRoot() {
  await fs.mkdir(ROOT, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(ROOT);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Visual Workspace state root must be a regular directory");
}

async function readJson(file, fallback) {
  try {
    const stats = await fs.lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${file} must be a regular file`);
    return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new Error(`Visual Workspace state is invalid and was left untouched: ${file}: ${error.message || error}`);
  }
}

async function atomicWriteJson(file, value) {
  await ensureStateRoot();
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withFileLock(name, operation) {
  await ensureStateRoot();
  const lockFile = path.join(ROOT, `${name}.lock`);
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    let handle;
    try {
      handle = await fs.open(lockFile, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readJson(lockFile, null).catch(() => null);
      const ownerAlive = Number.isInteger(owner?.pid) && owner.pid > 0
        ? await Promise.resolve().then(() => {
            try { process.kill(owner.pid, 0); return true; } catch (probeError) { return probeError?.code === "EPERM"; }
          })
        : false;
      const stale = !ownerAlive && await fs.stat(lockFile).then((stats) => Date.now() - stats.mtimeMs > LOCK_STALE_MS, () => false);
      if (stale) {
        await fs.rm(lockFile, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Visual Workspace state is busy; retry the action");
      await sleep(80);
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
      await handle.close();
    } catch (error) {
      await handle?.close().catch(() => {});
      const owner = await readJson(lockFile, null).catch(() => null);
      if (owner?.token === token) await fs.rm(lockFile, { force: true }).catch(() => {});
      throw error;
    }
    try {
      return await operation();
    } finally {
      const owner = await readJson(lockFile, null).catch(() => null);
      if (owner?.token === token) await fs.rm(lockFile, { force: true }).catch(() => {});
    }
  }
}

function isBroadRoot(root) {
  const normalized = path.resolve(root);
  const home = path.resolve(homedir());
  const denied = process.platform === "win32"
    ? [
        path.parse(normalized).root,
        home,
        path.dirname(home),
        process.env.SystemRoot,
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
        process.env.ProgramData,
      ]
    : [
        path.parse(normalized).root,
        home,
        path.dirname(home),
        "/Applications",
        "/Library",
        "/System",
        "/Users",
        "/Volumes",
        "/etc",
        "/private",
        "/tmp",
        "/usr",
        "/var",
      ];
  return denied.filter(Boolean).some((candidate) => path.resolve(candidate) === normalized);
}

export async function validateProjectRoot(projectDir) {
  const raw = String(projectDir || "").trim();
  if (!path.isAbsolute(raw)) throw new Error("projectDir must be an absolute path");
  if ([...raw].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error("projectDir contains unsupported control characters");
  }
  const requested = path.resolve(raw);
  if (isBroadRoot(requested)) throw new Error("Refusing to register a broad filesystem, system, or home-directory root");
  const stats = await fs.lstat(requested);
  if (!stats.isDirectory()) throw new Error("projectDir must be an existing directory");
  const real = await fs.realpath(requested);
  if (isBroadRoot(real)) throw new Error("Refusing to register a broad filesystem, system, or home-directory root");
  return real;
}

async function readRegularText(file, maximumBytes = 4096) {
  let stats;
  try {
    stats = await fs.lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximumBytes) return null;
  return await fs.readFile(file, "utf8");
}

async function gitRepositoryIdentity(projectRoot) {
  const marker = path.join(projectRoot, ".git");
  let markerStats;
  try {
    markerStats = await fs.lstat(marker);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (markerStats.isSymbolicLink()) return null;

  let commonDirectory;
  if (markerStats.isDirectory()) {
    commonDirectory = await fs.realpath(marker);
  } else if (markerStats.isFile() && markerStats.size <= 4096) {
    const pointer = await fs.readFile(marker, "utf8");
    const match = /^gitdir:\s*(.+?)\s*$/i.exec(pointer);
    if (!match) return null;
    const gitDirectory = await fs.realpath(path.resolve(projectRoot, match[1])).catch(() => null);
    if (!gitDirectory) return null;
    const gitDirectoryStats = await fs.lstat(gitDirectory);
    if (!gitDirectoryStats.isDirectory() || gitDirectoryStats.isSymbolicLink()) return null;
    const backlink = (await readRegularText(path.join(gitDirectory, "gitdir")))?.trim();
    if (!backlink || path.resolve(backlink) !== marker) return null;
    const commonPointer = (await readRegularText(path.join(gitDirectory, "commondir")))?.trim();
    if (!commonPointer) return null;
    commonDirectory = await fs.realpath(path.resolve(gitDirectory, commonPointer)).catch(() => null);
    if (!commonDirectory || !isContained(path.join(commonDirectory, "worktrees"), gitDirectory)) return null;
  } else {
    return null;
  }

  const [commonStats, objectsStats, headText, configText] = await Promise.all([
    fs.lstat(commonDirectory).catch(() => null),
    fs.lstat(path.join(commonDirectory, "objects")).catch(() => null),
    readRegularText(path.join(commonDirectory, "HEAD")),
    readRegularText(path.join(commonDirectory, "config"), 1024 * 1024),
  ]);
  if (!commonStats?.isDirectory() || commonStats.isSymbolicLink()
    || !objectsStats?.isDirectory() || objectsStats.isSymbolicLink()
    || headText === null || configText === null) return null;
  return createHash("sha256").update(commonDirectory).digest("hex");
}

async function readCatalog() {
  await ensureStateRoot();
  const catalog = await readJson(CATALOG_FILE, { version: 1, workspaces: [] });
  if (catalog?.version !== 1 || !Array.isArray(catalog.workspaces)) throw new Error("Visual Workspace catalog has an unsupported format");
  return catalog;
}

function validateAccessRequestState(state) {
  if (state?.version !== 1 || !Array.isArray(state.requests)) {
    throw new Error("Visual Workspace access-request state has an unsupported format");
  }
  for (const request of state.requests) {
    if (!request || typeof request !== "object"
      || !CAPABILITY_TOKEN_PATTERN.test(request.accessRequestId || "")
      || typeof request.projectDir !== "string"
      || !Number.isFinite(request.createdAt)
      || !Number.isFinite(request.expiresAt)) {
      throw new Error("Visual Workspace access-request state is invalid and was left untouched");
    }
  }
  return state;
}

async function initializeAccessRequestState() {
  await ensureStateRoot();
  let handle;
  try {
    handle = await fs.open(ACCESS_REQUESTS_FILE, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile('{"version":1,"requests":[]}\n');
  } finally {
    await handle?.close().catch(() => {});
  }
}

function accessRequestClaimOwner(name) {
  const match = /^\.access-requests\.claim-(\d+)-[a-f0-9-]+\.json$/.exec(name);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function accessRequestClaims() {
  const entries = await fs.readdir(ROOT, { withFileTypes: true });
  const claims = [];
  for (const entry of entries) {
    if (!entry.isFile() || accessRequestClaimOwner(entry.name) === null) continue;
    const file = path.join(ROOT, entry.name);
    const stats = await fs.lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Visual Workspace access-request claim must be a regular file");
    claims.push({ file, name: entry.name, pid: accessRequestClaimOwner(entry.name), stats });
  }
  return claims;
}

async function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function recoverAccessRequestClaim() {
  const claims = await accessRequestClaims();
  const canonicalExists = await fs.lstat(ACCESS_REQUESTS_FILE).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  let recovered = false;
  for (const claim of claims) {
    const stale = Date.now() - claim.stats.mtimeMs > LOCK_STALE_MS && !(await processIsAlive(claim.pid));
    if (!stale) continue;
    if (canonicalExists || recovered) {
      await fs.rm(claim.file, { force: true });
      continue;
    }
    try {
      await fs.rename(claim.file, ACCESS_REQUESTS_FILE);
      recovered = true;
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "EEXIST") throw error;
    }
  }
  return { claims: claims.length, recovered };
}

async function withAccessRequestState(operation) {
  await ensureStateRoot();
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    const claimFile = path.join(ROOT, `.access-requests.claim-${process.pid}-${randomUUID()}.json`);
    try {
      await fs.rename(ACCESS_REQUESTS_FILE, claimFile);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const recovery = await recoverAccessRequestClaim();
      if (recovery.recovered) continue;
      if (recovery.claims === 0) {
        try {
          await initializeAccessRequestState();
        } catch (initializeError) {
          if (initializeError?.code !== "EEXIST") throw initializeError;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Visual Workspace access-request state is busy; retry the action");
      await sleep(80);
      continue;
    }
    try {
      const current = validateAccessRequestState(await readJson(claimFile, null));
      const { nextState, result } = await operation(current);
      await atomicWriteJson(ACCESS_REQUESTS_FILE, validateAccessRequestState(nextState));
      await fs.rm(claimFile, { force: true });
      return result;
    } catch (error) {
      try {
        await fs.link(claimFile, ACCESS_REQUESTS_FILE);
        await fs.rm(claimFile, { force: true });
      } catch (restoreError) {
        if (restoreError?.code !== "EEXIST" && restoreError?.code !== "ENOENT") throw restoreError;
      }
      throw error;
    }
  }
}

function normalizeAccessRequestId(value) {
  const accessRequestId = String(value || "").trim();
  if (!CAPABILITY_TOKEN_PATTERN.test(accessRequestId)) throw new Error("Invalid project access request id");
  return accessRequestId;
}

export async function rememberProjectAccessRequest({ accessRequestId, projectDir }) {
  const id = normalizeAccessRequestId(accessRequestId);
  const root = await validateProjectRoot(projectDir);
  const now = Date.now();
  const request = { accessRequestId: id, projectDir: root, createdAt: now, expiresAt: now + ACCESS_REQUEST_TTL_MS };
  return await withAccessRequestState(async (current) => {
    const requests = current.requests
      .filter((entry) => entry.expiresAt > now && entry.accessRequestId !== id)
      .slice(-(MAX_ACCESS_REQUESTS - 1));
    requests.push(request);
    return {
      nextState: { version: 1, requests },
      result: { accessRequestId: id, expiresAt: new Date(request.expiresAt).toISOString() },
    };
  });
}

export async function consumeProjectAccessRequest(value) {
  const accessRequestId = normalizeAccessRequestId(value);
  const now = Date.now();
  const result = await withAccessRequestState(async (current) => {
    let matched = null;
    const requests = [];
    for (const entry of current.requests) {
      if (entry.expiresAt <= now) continue;
      if (!matched && entry.accessRequestId === accessRequestId) {
        matched = entry;
        continue;
      }
      requests.push(entry);
    }
    const projectDir = matched ? await validateProjectRoot(matched.projectDir) : null;
    return { nextState: { version: 1, requests }, result: { projectDir } };
  });
  if (!result.projectDir) throw new Error("Project access request expired; reopen Visual Workspace");
  return result.projectDir;
}

export async function approveProjectAccessRequest(value) {
  const accessRequestId = normalizeAccessRequestId(value);
  const now = Date.now();
  const result = await withAccessRequestState(async (current) => {
    const active = current.requests.filter((entry) => entry.expiresAt > now);
    const matched = active.find((entry) => entry.accessRequestId === accessRequestId) || null;
    if (!matched) return { nextState: { version: 1, requests: active }, result: { workspace: null } };
    const projectDir = await validateProjectRoot(matched.projectDir);
    const workspace = await registerWorkspace({
      projectDir,
      confirmProjectAccess: true,
      allowedRoots: [projectDir],
      approvalSource: "widget-approval",
    });
    return {
      nextState: { version: 1, requests: active.filter((entry) => entry.accessRequestId !== accessRequestId) },
      result: { workspace },
    };
  });
  if (!result.workspace) throw new Error("Project access request expired; reopen Visual Workspace");
  return result.workspace;
}

export async function registerWorkspace({ projectDir, confirmProjectAccess, allowedRoots = [], approvalSource = "host-root", approvalRootId = null }) {
  if (confirmProjectAccess !== true) {
    throw new Error("Opening a project requires confirmProjectAccess=true after the user asks to use Visual Workspace");
  }
  if (!APPROVAL_SOURCES.has(approvalSource)) throw new Error("Unsupported project approval source");
  const root = await validateProjectRoot(projectDir);
  const approvedRoots = [];
  for (const candidate of allowedRoots) {
    try {
      const approved = await validateProjectRoot(candidate);
      if (!isBroadRoot(approved)) approvedRoots.push(approved);
    } catch (_error) {
      // Invalid or unavailable client roots do not widen access.
    }
  }
  if (!approvedRoots.some((approved) => isContained(approved, root))) {
    throw new Error("projectDir is outside the workspace roots approved by the Codex host");
  }
  const workspaceId = workspaceIdFor(root);
  const catalog = await withFileLock("catalog", async () => {
    const current = await readCatalog();
    const existing = current.workspaces.find((entry) => entry.id === workspaceId);
    const effectiveApprovalSource = approvalSource === "host-root" && PERSISTENT_APPROVAL_SOURCES.has(existing?.approvalSource)
      ? existing.approvalSource
      : approvalSource;
    const nextEntry = {
      id: workspaceId,
      root,
      name: path.basename(root),
      approvedAt: existing?.approvedAt || new Date().toISOString(),
      lastOpenedAt: new Date().toISOString(),
      approvalSource: effectiveApprovalSource,
      ...(effectiveApprovalSource === "inherited-worktree"
        ? { approvalRootId: approvalRootId || existing?.approvalRootId || workspaceId }
        : {}),
    };
    const workspaces = current.workspaces.filter((entry) => entry.id !== workspaceId);
    workspaces.push(nextEntry);
    const next = { version: 1, workspaces };
    await atomicWriteJson(CATALOG_FILE, next);
    return next;
  });
  const workspace = catalog.workspaces.find((entry) => entry.id === workspaceId);
  return { workspaceId, projectName: workspace.name, projectRoot: workspace.root };
}

export async function reopenApprovedWorkspace(projectDir) {
  const root = await validateProjectRoot(projectDir);
  const workspaceId = workspaceIdFor(root);
  const catalog = await readCatalog();
  const exact = catalog.workspaces.find((entry) => entry.id === workspaceId && entry.root === root);
  if (exact && PERSISTENT_APPROVAL_SOURCES.has(exact.approvalSource)) {
    return { workspaceId, projectName: exact.name, projectRoot: exact.root };
  }

  const repositoryId = await gitRepositoryIdentity(root);
  if (!repositoryId) return null;
  for (const entry of catalog.workspaces) {
    if (!PERSISTENT_APPROVAL_SOURCES.has(entry.approvalSource)) continue;
    try {
      const approvedRoot = await validateProjectRoot(entry.root);
      if (await gitRepositoryIdentity(approvedRoot) !== repositoryId) continue;
      return await registerWorkspace({
        projectDir: root,
        confirmProjectAccess: true,
        allowedRoots: [root],
        approvalSource: "inherited-worktree",
        approvalRootId: entry.approvalRootId || entry.id,
      });
    } catch (_error) {
      // Missing or invalid historical roots never widen current project access.
    }
  }
  return null;
}

export async function resolveWorkspace(workspaceId) {
  const id = String(workspaceId || "").trim();
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid workspaceId");
  const catalog = await readCatalog();
  const workspace = catalog.workspaces.find((entry) => entry.id === id);
  if (!workspace) throw new Error("Workspace is not approved; open it from the plugin first");
  const realRoot = await validateProjectRoot(workspace.root);
  if (workspaceIdFor(realRoot) !== id) throw new Error("Approved workspace root changed on disk");
  return { ...workspace, root: realRoot };
}

export async function assertWorkspaceAllowed(workspaceId, allowedRoots = []) {
  const workspace = await resolveWorkspace(workspaceId);
  const approvedRoots = [];
  for (const candidate of allowedRoots) {
    try {
      const approved = await validateProjectRoot(candidate);
      if (!isBroadRoot(approved)) approvedRoots.push(approved);
    } catch (_error) {
      // Invalid or unavailable client roots do not widen access.
    }
  }
  if (!approvedRoots.some((approved) => isContained(approved, workspace.root))) {
    throw new Error("Workspace is outside the roots approved for the current Codex task");
  }
  return workspace;
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeRelativeAsset(value) {
  const raw = String(value || "").trim();
  if (!raw || path.isAbsolute(raw)) throw new Error("Asset path must be project-relative");
  if (/[\u0000-\u001f\u007f]/u.test(raw)) throw new Error("Asset path contains unsupported control characters");
  const normalized = path.normalize(raw);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) throw new Error("Asset path escapes the project");
  if (!IMAGE_EXTENSIONS.has(path.extname(normalized).toLowerCase())) throw new Error("Unsupported image type");
  return normalized;
}

async function resolveAsset(workspace, relPath) {
  const normalized = normalizeRelativeAsset(relPath);
  const lexical = path.resolve(workspace.root, normalized);
  if (!isContained(workspace.root, lexical)) throw new Error("Asset path escapes the project");
  const stats = await fs.lstat(lexical);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Asset must be a regular file");
  const real = await fs.realpath(lexical);
  if (!isContained(workspace.root, real)) throw new Error("Asset resolves outside the project");
  return { normalized, filePath: real, stats };
}

export async function scanWorkspaceAssets(workspaceId) {
  const workspace = await resolveWorkspace(workspaceId);
  const assets = [];
  const startedAt = Date.now();
  let truncated = false;
  let visitedEntries = 0;

  async function walk(directory, depth) {
    if (assets.length >= MAX_ASSETS || visitedEntries > MAX_SCAN_ENTRIES || Date.now() - startedAt >= MAX_SCAN_MS) {
      truncated = true;
      return;
    }
    if (depth > MAX_DEPTH) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await fs.opendir(directory);
    } catch (error) {
      if (["EACCES", "EPERM", "ENOENT"].includes(error?.code)) {
        truncated = true;
        return;
      }
      throw error;
    }
    try {
      for await (const entry of entries) {
        visitedEntries += 1;
        if (visitedEntries > MAX_SCAN_ENTRIES) {
          truncated = true;
          return;
        }
        if (assets.length >= MAX_ASSETS || Date.now() - startedAt >= MAX_SCAN_MS) {
          truncated = true;
          return;
        }
        if (entry.isSymbolicLink()) continue;
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRECTORIES.has(entry.name)) await walk(fullPath, depth + 1);
          continue;
        }
        if (!entry.isFile() || !IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const real = await fs.realpath(fullPath).catch(() => null);
        if (!real || !isContained(workspace.root, real)) continue;
        const stats = await fs.stat(real).catch(() => null);
        if (!stats?.isFile()) continue;
        const relPath = path.relative(workspace.root, real).split(path.sep).join("/");
        if (/[\u0000-\u001f\u007f]/u.test(relPath)) continue;
        assets.push({
          id: createHash("sha256").update(relPath).digest("hex").slice(0, 16),
          relPath,
          name: path.basename(real),
          folder: path.dirname(relPath) === "." ? "" : path.dirname(relPath).split(path.sep).join("/"),
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        });
      }
    } catch (error) {
      if (["EACCES", "EPERM", "ENOENT"].includes(error?.code)) {
        truncated = true;
        return;
      }
      throw error;
    }
  }

  await walk(workspace.root, 0);
  assets.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
  return { workspaceId, projectName: workspace.name, assets, truncated, limits: { maxAssets: MAX_ASSETS, maxDepth: MAX_DEPTH, maxEntries: MAX_SCAN_ENTRIES, maxScanMs: MAX_SCAN_MS } };
}

export async function readWorkspaceAsset({ workspaceId, relPath }) {
  const workspace = await resolveWorkspace(workspaceId);
  const asset = await resolveAsset(workspace, relPath);
  const handle = await fs.open(asset.filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("Asset must remain a regular file");
    if (stats.size > MAX_PREVIEW_BYTES) throw new Error(`Image is too large to preview (${stats.size} bytes)`);
    return {
      workspaceId,
      relPath: asset.normalized.split(path.sep).join("/"),
      mimeType: IMAGE_EXTENSIONS.get(path.extname(asset.normalized).toLowerCase()),
      size: stats.size,
      dataBase64: (await handle.readFile()).toString("base64"),
    };
  } finally {
    await handle.close();
  }
}

function boardFile(workspaceId) {
  return path.join(ROOT, `${workspaceId}.canvas.json`);
}

function finiteNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function normalizeNode(node, index) {
  if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error(`Canvas node ${index + 1} must be an object`);
  const id = String(node.id || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(id)) throw new Error(`Canvas node ${index + 1} has an invalid id`);
  const kind = node.kind === "asset" || node.kind === "note" ? node.kind : "";
  if (!kind) throw new Error(`Canvas node ${index + 1} has an unsupported kind`);
  const normalized = {
    id,
    kind,
    x: finiteNumber(node.x, 0, -1_000_000, 1_000_000),
    y: finiteNumber(node.y, 0, -1_000_000, 1_000_000),
    width: finiteNumber(node.width, kind === "asset" ? 320 : 260, 120, 1_200),
    height: finiteNumber(node.height, kind === "asset" ? 220 : 180, 90, 900),
    z: Math.round(finiteNumber(node.z, index, 0, 100_000)),
  };
  if (kind === "asset") {
    normalized.relPath = normalizeRelativeAsset(node.relPath).split(path.sep).join("/");
    normalized.label = String(node.label || path.basename(normalized.relPath)).slice(0, 300);
  } else {
    normalized.text = String(node.text || "").slice(0, MAX_NOTE_LENGTH);
    normalized.tone = ["neutral", "blue", "amber", "green", "rose"].includes(node.tone) ? node.tone : "neutral";
  }
  return normalized;
}

function normalizeBoard(value, workspaceId) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const nodes = Array.isArray(source.nodes) ? source.nodes : [];
  if (nodes.length > MAX_NODES) throw new Error(`Canvas supports at most ${MAX_NODES} nodes`);
  const normalizedNodes = nodes.map(normalizeNode);
  if (new Set(normalizedNodes.map((node) => node.id)).size !== normalizedNodes.length) throw new Error("Canvas node ids must be unique");
  const selectedIds = Array.isArray(source.selectedIds)
    ? source.selectedIds.map(String).filter((id) => normalizedNodes.some((node) => node.id === id)).slice(0, MAX_NODES)
    : [];
  return {
    version: 1,
    workspaceId,
    rev: Number.isSafeInteger(source.rev) && source.rev >= 0 ? source.rev : 0,
    viewport: {
      x: finiteNumber(source.viewport?.x, 0, -1_000_000, 1_000_000),
      y: finiteNumber(source.viewport?.y, 0, -1_000_000, 1_000_000),
      scale: finiteNumber(source.viewport?.scale, 1, 0.1, 8),
    },
    nodes: normalizedNodes,
    selectedIds: [...new Set(selectedIds)],
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
}

export async function readWorkspaceBoard(workspaceId) {
  await resolveWorkspace(workspaceId);
  const source = await readJson(boardFile(workspaceId), {});
  return normalizeBoard(source, workspaceId);
}

export async function saveWorkspaceBoard({ workspaceId, baseRev, viewport, nodes, selectedIds }) {
  const workspace = await resolveWorkspace(workspaceId);
  return await withFileLock(`canvas-${workspaceId}`, async () => {
    const current = await readWorkspaceBoard(workspaceId);
    if (!Number.isSafeInteger(baseRev) || baseRev !== current.rev) {
      const error = new Error(`Canvas changed elsewhere (expected revision ${current.rev})`);
      error.code = "REVISION_CONFLICT";
      error.current = current;
      throw error;
    }
    const next = normalizeBoard({
      rev: current.rev + 1,
      viewport,
      nodes,
      selectedIds,
      updatedAt: new Date().toISOString(),
    }, workspaceId);
    for (const node of next.nodes) {
      if (node.kind === "asset") await resolveAsset(workspace, node.relPath);
    }
    await atomicWriteJson(boardFile(workspaceId), next);
    return next;
  });
}

export async function selectedWorkspaceAssets(workspaceId) {
  const workspace = await resolveWorkspace(workspaceId);
  const board = await readWorkspaceBoard(workspaceId);
  const selected = [];
  for (const node of board.nodes) {
    if (node.kind !== "asset" || !board.selectedIds.includes(node.id)) continue;
    const asset = await resolveAsset(workspace, node.relPath);
    selected.push({
      nodeId: node.id,
      relPath: node.relPath,
      absolutePath: asset.filePath,
    });
  }
  return { workspaceId, projectName: workspace.name, selected };
}

export const workspaceLimits = Object.freeze({
  maxAssets: MAX_ASSETS,
  maxDepth: MAX_DEPTH,
  maxEntries: MAX_SCAN_ENTRIES,
  maxScanMs: MAX_SCAN_MS,
  maxPreviewBytes: MAX_PREVIEW_BYTES,
  maxNodes: MAX_NODES,
});

export const accessRequestLimits = Object.freeze({
  ttlMs: ACCESS_REQUEST_TTL_MS,
  maxRequests: MAX_ACCESS_REQUESTS,
});
