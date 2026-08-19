import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED = ["@modelcontextprotocol/ext-apps", "@modelcontextprotocol/sdk", "zod"];

function dependencyPath(name) {
  return path.join(ROOT, "node_modules", ...name.split("/"));
}

const missing = REQUIRED.filter((name) => !existsSync(dependencyPath(name)));
if (missing.length) {
  throw new Error(`Visual Workspace dependencies are missing (${missing.join(", ")}). Reinstall the plugin; runtime network installation is disabled.`);
}

process.chdir(ROOT);
await import(pathToFileURL(path.join(ROOT, "mcp", "server.mjs")).href);
