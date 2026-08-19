import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(os.tmpdir(), "visual-workspace-release-"));
const releaseRoot = path.join(temporary, "codex-workspace-enhancer");

try {
  await cp(ROOT, releaseRoot, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(ROOT, source);
      return relative !== "node_modules" && !relative.startsWith(`node_modules${path.sep}`);
    },
  });
  const result = spawnSync(process.execPath, [
    path.join(ROOT, "scripts", "probe-mcp.mjs"),
    "--server",
    path.join(releaseRoot, "dist", "server.mjs"),
  ], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Standalone release probe failed\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  process.stdout.write(result.stdout);
  process.stdout.write("OK: standalone release works without node_modules in the installed plugin copy.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
