#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = path.join(skillRoot, "assets", "runtime");
const outputPath = path.join(runtimeRoot, "manifest.macos.sha256.json");
const roots = ["enhancer", "asset-browser"];

async function listFiles(relativeRoot) {
  const absoluteRoot = path.join(runtimeRoot, relativeRoot);
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".DS_Store" || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && !entry.name.endsWith(".pyc")) files.push(absolute);
    }
  }
  await visit(absoluteRoot);
  return files;
}

const files = [];
for (const relativeRoot of roots) {
  for (const absolute of await listFiles(relativeRoot)) {
    const body = await readFile(absolute);
    const info = await stat(absolute);
    files.push({
      path: path.relative(runtimeRoot, absolute).split(path.sep).join("/"),
      sha256: createHash("sha256").update(body).digest("hex"),
      size: info.size,
      executable: Boolean(info.mode & 0o111),
    });
  }
}
files.sort((left, right) => left.path.localeCompare(right.path));
const manifest = {
  format: "codex-workspace-enhancer-macos-v1",
  generatedAt: new Date().toISOString(),
  files,
};
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${outputPath}\n${files.length} files\n`);
