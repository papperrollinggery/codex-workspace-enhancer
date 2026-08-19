import os from "node:os";
import path from "node:path";

export const PRODUCT_NAME = "Codex Sidebar Enhancer";
export const PRODUCT_ID = "com.yubowen.codex-sidebar-enhancer";
export const LAUNCH_AGENT_LABEL = PRODUCT_ID;
export const LAUNCHER_BUNDLE_ID = `${PRODUCT_ID}.launcher`;
export const DEFAULT_DEBUG_PORT = 9231;
export const INSTALL_MANIFEST_FILENAME = "install-manifest.json";
export const OWNERSHIP_MARKER_FILENAME = ".codex-sidebar-enhancer-owned";
export const OWNERSHIP_MARKER_CONTENT = "Codex Sidebar Enhancer owned path v1\n";
export const INSTALL_MANIFEST_SCHEMA = 1;
export const SUPPORTED_APP_PATHS = Object.freeze([
  "/Applications/ChatGPT.app",
  "/Applications/Codex.app",
]);

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertAbsolutePath(name, value) {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }
  return path.resolve(value);
}

function assertExactPath(name, actual, expected) {
  if (path.resolve(actual) !== path.resolve(expected)) {
    throw new Error(`${name} must be exactly ${expected}`);
  }
}

function assertSafeHome(home) {
  const resolved = assertAbsolutePath("home", home);
  if (resolved === path.parse(resolved).root) {
    throw new Error("home must not be a filesystem root");
  }
  return resolved;
}

function assertPort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("port must be an integer between 1024 and 65535");
  }
  return port;
}

export function expectedOwnedPaths(home = os.homedir()) {
  const safeHome = assertSafeHome(home);
  const applicationSupportDir = path.join(safeHome, "Library", "Application Support");
  const installDir = path.join(applicationSupportDir, PRODUCT_NAME);
  const stateDir = path.join(applicationSupportDir, "CodexSidebarEnhancer");
  const launchAgentsDir = path.join(safeHome, "Library", "LaunchAgents");
  const logsDir = path.join(safeHome, "Library", "Logs", "CodexSidebarEnhancer");
  const launcherPath = path.join(safeHome, "Applications", `${PRODUCT_NAME}.app`);
  return Object.freeze({
    home: safeHome,
    installDir,
    stateDir,
    launchAgentsDir,
    logsDir,
    plistPath: path.join(launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`),
    launcherPath,
  });
}

export function assertExactOwnedRoots(plan) {
  const expected = expectedOwnedPaths(plan.home);
  for (const key of [
    "installDir",
    "stateDir",
    "launchAgentsDir",
    "logsDir",
    "plistPath",
    "launcherPath",
  ]) {
    assertExactPath(key, plan[key], expected[key]);
  }
  return true;
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function createInstallPlan({
  home = os.homedir(),
  installDir,
  stateDir,
  logsDir,
  plistPath,
  launcherPath,
  nodePath = process.execPath,
  port = DEFAULT_DEBUG_PORT,
} = {}) {
  const expected = expectedOwnedPaths(home);
  const plan = {
    ...expected,
    installDir: installDir === undefined ? expected.installDir : assertAbsolutePath("installDir", installDir),
    stateDir: stateDir === undefined ? expected.stateDir : assertAbsolutePath("stateDir", stateDir),
    logsDir: logsDir === undefined ? expected.logsDir : assertAbsolutePath("logsDir", logsDir),
    plistPath: plistPath === undefined ? expected.plistPath : assertAbsolutePath("plistPath", plistPath),
    launcherPath: launcherPath === undefined ? expected.launcherPath : assertAbsolutePath("launcherPath", launcherPath),
    label: LAUNCH_AGENT_LABEL,
    port: assertPort(port),
    nodePath: assertAbsolutePath("nodePath", nodePath),
    supportedAppPaths: [...SUPPORTED_APP_PATHS],
  };
  assertExactOwnedRoots(plan);

  plan.installManifestPath = path.join(plan.installDir, INSTALL_MANIFEST_FILENAME);
  plan.stateManifestPath = path.join(plan.stateDir, INSTALL_MANIFEST_FILENAME);
  plan.installMarkerPath = path.join(plan.installDir, OWNERSHIP_MARKER_FILENAME);
  plan.stateMarkerPath = path.join(plan.stateDir, OWNERSHIP_MARKER_FILENAME);
  plan.logsMarkerPath = path.join(plan.logsDir, OWNERSHIP_MARKER_FILENAME);
  plan.launcherContentsDir = path.join(plan.launcherPath, "Contents");
  plan.launcherExecutablePath = path.join(plan.launcherContentsDir, "MacOS", PRODUCT_NAME);
  plan.launcherInfoPlistPath = path.join(plan.launcherContentsDir, "Info.plist");
  plan.injectorPath = path.join(plan.installDir, "scripts", "injector.mjs");
  plan.stdoutPath = path.join(plan.logsDir, "injector.log");
  plan.stderrPath = path.join(plan.logsDir, "injector.error.log");

  plan.plist = createLaunchAgentPlist(plan);
  plan.launcherInfoPlist = createLauncherInfoPlist();
  plan.launcherScript = createLauncherScript(plan);
  plan.actions = Object.freeze([
    { action: "install-runtime", path: plan.installDir },
    { action: "write-owned-state", path: plan.stateDir },
    { action: "write-launch-agent", path: plan.plistPath },
    { action: "write-launcher", path: plan.launcherPath },
    { action: "write-logs", path: plan.logsDir },
    { action: "launchctl-bootstrap", service: plan.label },
  ]);
  return Object.freeze(plan);
}

export function createInstallManifest(plan, {
  version = "0.0.0",
  installedAt = new Date().toISOString(),
} = {}) {
  assertExactOwnedRoots(plan);
  return Object.freeze({
    schema: INSTALL_MANIFEST_SCHEMA,
    product: PRODUCT_NAME,
    productId: PRODUCT_ID,
    version: String(version),
    installedAt,
    launchAgentLabel: plan.label,
    port: plan.port,
    ownedRoots: {
      installDir: plan.installDir,
      stateDir: plan.stateDir,
      logsDir: plan.logsDir,
      plistPath: plan.plistPath,
      launcherPath: plan.launcherPath,
    },
  });
}

export function validateInstallManifest(manifest, plan) {
  const issues = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["manifest is not an object"];
  }
  if (manifest.schema !== INSTALL_MANIFEST_SCHEMA) issues.push("manifest schema mismatch");
  if (manifest.product !== PRODUCT_NAME) issues.push("manifest product mismatch");
  if (manifest.productId !== PRODUCT_ID) issues.push("manifest product id mismatch");
  if (manifest.launchAgentLabel !== plan.label) issues.push("manifest launch agent label mismatch");
  const expectedRoots = {
    installDir: plan.installDir,
    stateDir: plan.stateDir,
    logsDir: plan.logsDir,
    plistPath: plan.plistPath,
    launcherPath: plan.launcherPath,
  };
  for (const [key, expected] of Object.entries(expectedRoots)) {
    if (typeof manifest.ownedRoots?.[key] !== "string" || path.resolve(manifest.ownedRoots[key]) !== path.resolve(expected)) {
      issues.push(`manifest owned root mismatch: ${key}`);
    }
  }
  return issues;
}

function createLaunchAgentPlist(plan) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(plan.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(plan.nodePath)}</string>
    <string>${xml(plan.injectorPath)}</string>
    <string>--port</string>
    <string>${xml(plan.port)}</string>
    <string>--watch</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(plan.installDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xml(plan.home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(plan.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(plan.stderrPath)}</string>
</dict>
</plist>
`;
}

function createLauncherInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>${PRODUCT_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${PRODUCT_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>${LAUNCHER_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>${PRODUCT_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
</dict>
</plist>
`;
}

function createLauncherScript(plan) {
  return `#!/bin/zsh
# CodexSidebarEnhancerLauncher:v1
set -eu

PORT=${plan.port}
APP_PATH=""
APP_NAME=""
for CANDIDATE in "/Applications/ChatGPT.app" "/Applications/Codex.app"; do
  if [[ -d "\${CANDIDATE}" ]]; then
    APP_PATH="\${CANDIDATE}"
    APP_NAME="\${CANDIDATE:t:r}"
    if /usr/bin/pgrep -x "\${APP_NAME}" >/dev/null 2>&1; then
      break
    fi
  fi
done

if [[ -z "\${APP_PATH}" ]]; then
  /usr/bin/osascript -e 'display alert "Codex Sidebar Enhancer" message "没有找到 /Applications/ChatGPT.app 或 /Applications/Codex.app。" as critical'
  exit 1
fi

if /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:\${PORT}/json" >/dev/null 2>&1; then
  /usr/bin/open "\${APP_PATH}"
  exit 0
fi

if /usr/bin/pgrep -x "\${APP_NAME}" >/dev/null 2>&1; then
  /usr/bin/osascript -e 'display alert "Codex Sidebar Enhancer" message "ChatGPT/Codex 当前正在运行，安装器不会自动重启它。请先正常退出应用，再重新打开 Codex Sidebar Enhancer。"'
  exit 2
fi

/usr/bin/open -na "\${APP_PATH}" --args \\
  "--remote-debugging-address=127.0.0.1" \\
  "--remote-debugging-port=\${PORT}" \\
  "--remote-allow-origins=http://127.0.0.1:\${PORT}" \\
  "--enable-features=LocalNetworkAccessForSubframeNavigationsWarningOnly"
`;
}
