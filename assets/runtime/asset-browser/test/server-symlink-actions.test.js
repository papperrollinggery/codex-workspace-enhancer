import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("move and trash APIs reject project symlink escapes", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "asset-browser-symlink-api-"));
  const stateRoot = path.join(temporary, "state");
  const projectRoot = path.join(temporary, "project");
  const externalRoot = path.join(temporary, "external");
  const externalFile = path.join(externalRoot, "outside.png");
  const token = "a".repeat(64);
  const port = await availablePort();
  let child;
  try {
    await mkdir(stateRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await mkdir(externalRoot, { recursive: true });
    await writeFile(externalFile, "outside\n", "utf8");
    await symlink(externalRoot, path.join(projectRoot, "linked"), "dir");
    await writeFile(path.join(stateRoot, ".api-token"), `${token}\n`, "utf8");
    await writeFile(path.join(stateRoot, "asset-browser.config.json"), `${JSON.stringify({
      enabled: true,
      projects: [{ id: "project", name: "Project", path: projectRoot, scanRoots: ["."] }],
    }, null, 2)}\n`, "utf8");
    child = spawn(process.execPath, [SERVER_PATH], {
      cwd: SERVER_ROOT,
      env: { ...process.env, ASSET_BROWSER_ROOT: stateRoot, PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
          headers: { "x-asset-console-token": token, origin: `http://127.0.0.1:${port}` },
        });
        if (response.status === 200) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, stderr);

    const page = await fetch(`http://127.0.0.1:${port}/`);
    const cookie = String(page.headers.get("set-cookie") || "").split(";", 1)[0];
    assert.match(cookie, /^asset_console_session=[a-f0-9]{64}$/);
    const browserSession = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      headers: { cookie, origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(browserSession.status, 200);

    const request = async (pathname, body) => fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-asset-console-token": token,
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify(body),
    });
    const trash = await request("/api/trash-assets", {
      items: [{ projectId: "project", sourcePath: "linked/outside.png" }],
    });
    assert.equal(trash.status, 500);
    const move = await request("/api/move-asset", {
      sourceProjectId: "project",
      sourcePath: "linked/outside.png",
      targetProjectId: "project",
      targetDirectory: "safe",
    });
    assert.equal(move.status, 500);
    assert.equal(await readFile(externalFile, "utf8"), "outside\n");
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
