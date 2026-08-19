import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SERVER_PATH = fileURLToPath(new URL("../server.js", import.meta.url));
const SERVER_ROOT = path.dirname(SERVER_PATH);

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function startFixture({ stateRoot, projectRoot, port, token }) {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(path.join(stateRoot, ".api-token"), `${token}\n`, "utf8");
  await writeFile(path.join(stateRoot, "asset-browser.config.json"), `${JSON.stringify({
    enabled: true,
    projects: [{ id: "project", name: "Project", path: projectRoot, scanRoots: ["."] }],
  }, null, 2)}\n`, "utf8");
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: SERVER_ROOT,
    env: { ...process.env, ASSET_BROWSER_ROOT: stateRoot, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        headers: { "x-asset-console-token": token, origin: `http://127.0.0.1:${port}` },
      });
      if (response.status === 200) return { child, stderr: () => stderr };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stopChild(child);
  throw new Error(`AssetBrowser did not start: ${stderr}`);
}

test("invalid config fails closed and remains untouched", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "asset-browser-config-safety-"));
  const stateRoot = path.join(temporary, "state");
  const configPath = path.join(stateRoot, "asset-browser.config.json");
  const invalid = "{\"enabled\":true,\n";
  const port = await availablePort();
  let child;
  try {
    await mkdir(stateRoot, { recursive: true });
    await writeFile(path.join(stateRoot, ".api-token"), `${"b".repeat(64)}\n`, "utf8");
    await writeFile(configPath, invalid, "utf8");
    child = spawn(process.execPath, [SERVER_PATH], {
      cwd: SERVER_ROOT,
      env: { ...process.env, ASSET_BROWSER_ROOT: stateRoot, PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    assert.notEqual(child.exitCode, null, "server should exit instead of serving an empty config");
    assert.notEqual(child.exitCode, 0);
    assert.match(stderr, /config is invalid and was left untouched/i);
    assert.equal(await readFile(configPath, "utf8"), invalid);
    assert.equal(await pathExists(`${configPath}.bak`), false);
  } finally {
    await stopChild(child);
    await rm(temporary, { recursive: true, force: true });
  }
});

test("manual mutations protect delivery paths, symlink metadata, and trash atomicity", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "asset-browser-mutation-safety-"));
  const stateRoot = path.join(temporary, "state");
  const projectRoot = path.join(temporary, "project");
  const externalRoot = path.join(temporary, "external");
  const deliveryFile = path.join(projectRoot, "FinalDelivery", "client-master.mov");
  const normalFile = path.join(projectRoot, "working.png");
  const token = "c".repeat(64);
  const port = await availablePort();
  let child;
  try {
    await mkdir(path.dirname(deliveryFile), { recursive: true });
    await mkdir(externalRoot, { recursive: true });
    await writeFile(deliveryFile, "master\n", "utf8");
    await writeFile(normalFile, "working\n", "utf8");
    await writeFile(path.join(externalRoot, "outside.png"), "outside\n", "utf8");
    await symlink(externalRoot, path.join(projectRoot, "linked-case"), "dir");
    const fixture = await startFixture({ stateRoot, projectRoot, port, token });
    child = fixture.child;
    const request = (pathname, body) => fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-asset-console-token": token,
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify(body),
    });

    const protectedTrash = await request("/api/trash-assets", {
      items: [{ projectId: "project", sourcePath: "FinalDelivery/client-master.mov" }],
    });
    assert.equal(protectedTrash.status, 500);
    assert.equal(await readFile(deliveryFile, "utf8"), "master\n");

    const symlinkMark = await request("/api/mark", {
      projectId: "project",
      caseId: "linked-case",
      assetId: "outside.png",
      notes: "must not escape",
    });
    assert.equal(symlinkMark.status, 500);
    assert.equal(await pathExists(path.join(externalRoot, ".asset-review-meta.json")), false);

    const duplicateTrash = await request("/api/trash-assets", {
      items: [
        { projectId: "project", sourcePath: "working.png" },
        { projectId: "project", sourcePath: "working.png" },
      ],
    });
    assert.equal(duplicateTrash.status, 500);
    assert.equal(await readFile(normalFile, "utf8"), "working\n");
    const trashRoot = path.join(stateRoot, "action-trash");
    assert.deepEqual(await readdir(trashRoot).catch(() => []), []);

    const trashed = await request("/api/trash-assets", {
      items: [{ projectId: "project", sourcePath: "working.png" }],
    });
    assert.equal(trashed.status, 200);
    const payload = await trashed.json();
    assert.equal(await pathExists(normalFile), false);
    const restored = await request("/api/restore-trash", { token: payload.result.token });
    assert.equal(restored.status, 200);
    assert.equal(await readFile(normalFile, "utf8"), "working\n");
  } finally {
    await stopChild(child);
    await rm(temporary, { recursive: true, force: true });
  }
});
