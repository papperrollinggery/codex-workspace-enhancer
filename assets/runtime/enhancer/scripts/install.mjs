#!/usr/bin/env node

export {
  installMac,
  inspectOwnedInstallation,
  inspectSupportedApps,
  launchctlDomain,
  main,
  parseInstallArgs,
  resolveBundleSource,
} from "./install-macos.mjs";

import { main } from "./install-macos.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
