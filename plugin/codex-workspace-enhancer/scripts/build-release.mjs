import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

import { createMcpAppsBundle } from "../mcp/lib/widget-resource.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const require = createRequire(import.meta.url);

function packageRootFromInput(input) {
  const absolute = path.resolve(ROOT, input);
  const marker = `${path.sep}node_modules${path.sep}`;
  const markerIndex = absolute.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const packageBase = absolute.slice(0, markerIndex + marker.length);
  const packageParts = absolute.slice(markerIndex + marker.length).split(path.sep);
  if (!packageParts[0]) return null;
  const packageName = packageParts[0].startsWith("@") ? path.join(packageParts[0], packageParts[1] || "") : packageParts[0];
  return packageName ? path.join(packageBase, packageName) : null;
}

async function thirdPartyLicenses(inputs) {
  const roots = [...new Set(Object.keys(inputs).map(packageRootFromInput).filter(Boolean))].sort();
  const sections = [];
  for (const packageRoot of roots) {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    const licenseFiles = (await readdir(packageRoot)).filter((name) => /^licen[cs]e(?:\.|$)/i.test(name)).sort();
    const licenseText = licenseFiles.length
      ? (await Promise.all(licenseFiles.map((name) => readFile(path.join(packageRoot, name), "utf8")))).join("\n\n")
      : "License text is available from the package's canonical distribution.";
    sections.push(`${"=".repeat(78)}\n${manifest.name}@${manifest.version} — ${manifest.license || "license not declared"}\n${"=".repeat(78)}\n${licenseText.trim()}\n`);
  }
  return `Third-party licenses for the bundled Visual Workspace MCP server\n\n${sections.join("\n")}`;
}

await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });

const browserSource = await readFile(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
const embeddedBundle = createMcpAppsBundle(browserSource);
const result = await build({
  entryPoints: [path.join(ROOT, "mcp", "server.mjs")],
  outfile: path.join(DIST, "server.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minify: true,
  sourcemap: false,
  legalComments: "eof",
  metafile: true,
  define: {
    __VISUAL_WORKSPACE_MCP_APPS_BUNDLE__: JSON.stringify(embeddedBundle),
  },
});

await writeFile(path.join(DIST, "THIRD_PARTY_LICENSES.txt"), await thirdPartyLicenses(result.metafile.inputs), "utf8");
process.stdout.write(`Built standalone MCP server: ${path.relative(ROOT, path.join(DIST, "server.mjs"))}\n`);
