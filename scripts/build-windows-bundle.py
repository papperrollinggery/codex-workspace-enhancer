#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "assets" / "runtime"
ENHANCER = RUNTIME / "enhancer"
ARCHIVE = RUNTIME / "codex-sidebar-enhancer-windows.zip"
MANIFEST = RUNTIME / "manifest.sha256.json"
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)

WINDOWS_ARCHIVE_PATHS = (
    "asset-console/public/app.js",
    "asset-console/public/index.html",
    "asset-console/public/ui-v3.css",
    "inject/conversation-preview.user.js",
    "lib/asset-console-embed.mjs",
    "lib/card-view.mjs",
    "lib/home-projects.mjs",
    "lib/injector-state.mjs",
    "lib/install-config.mjs",
    "lib/preview-data.mjs",
    "lib/usage-data.mjs",
    "scripts/cdp-client.mjs",
    "scripts/injector.mjs",
    "scripts/inspect-hover.mjs",
    "scripts/inspect-sidebar.mjs",
    "scripts/install.mjs",
    "scripts/remove-injection.mjs",
    "scripts/verify-card-view.mjs",
    "scripts/verify-folder-switcher.mjs",
    "scripts/verify-home-projects.mjs",
    "scripts/verify-reload-persistence.mjs",
    "scripts/verify-section-tabs.mjs",
    "scripts/verify-shortcut-grid.mjs",
    "scripts/verify-skill-manager.mjs",
    "scripts/verify-usage-display.mjs",
    "scripts/verify-view-switch.mjs",
    "windows/launch.ps1",
    "windows/start-injector.ps1",
    "windows/stop-injector.ps1",
    "windows/uninstall.ps1",
    "install-windows.ps1",
    "LICENSE",
    "package.json",
    "README-Windows.txt",
    "README.md",
    "VERIFICATION.txt",
)


def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def archive_bytes() -> bytes:
    output = io.BytesIO()
    with ZipFile(output, "w", compression=ZIP_STORED) as archive:
        for relative in WINDOWS_ARCHIVE_PATHS:
            source = ENHANCER / relative
            if not source.is_file():
                raise SystemExit(f"missing Windows enhancer source: {relative}")
            info = ZipInfo(relative, FIXED_ZIP_TIME)
            info.compress_type = ZIP_STORED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, source.read_bytes())
    return output.getvalue()


def expected_manifest(archive_body: bytes) -> dict[str, object]:
    current = json.loads(MANIFEST.read_text(encoding="utf-8-sig"))
    entries = []
    expected_enhancer = {f"enhancer/{relative}" for relative in WINDOWS_ARCHIVE_PATHS}
    manifest_enhancer = {
        str(entry.get("path"))
        for entry in current.get("files", [])
        if str(entry.get("path", "")).startswith("enhancer/")
    }
    if manifest_enhancer != expected_enhancer:
        missing = sorted(expected_enhancer - manifest_enhancer)
        extra = sorted(manifest_enhancer - expected_enhancer)
        raise SystemExit(f"Windows manifest/source list mismatch; missing={missing}, extra={extra}")
    for entry in current.get("files", []):
        relative = str(entry.get("path", ""))
        source = RUNTIME / relative
        if not source.is_file():
            raise SystemExit(f"missing runtime manifest source: {relative}")
        body = source.read_bytes()
        entries.append({"path": relative, "sha256": digest(body), "size": len(body)})
    return {
        "schemaVersion": 1,
        "enhancerZipSha256": digest(archive_body),
        "files": entries,
    }


def encoded_manifest(value: dict[str, object]) -> bytes:
    return f"{json.dumps(value, ensure_ascii=False, indent=2)}\n".encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Build or verify the deterministic legacy Windows bundle")
    parser.add_argument("--check", action="store_true", help="Verify without writing files")
    args = parser.parse_args()

    archive_body = archive_bytes()
    manifest_body = encoded_manifest(expected_manifest(archive_body))
    if args.check:
        failures = []
        if not ARCHIVE.is_file() or ARCHIVE.read_bytes() != archive_body:
            failures.append(str(ARCHIVE))
        if not MANIFEST.is_file() or MANIFEST.read_bytes() != manifest_body:
            failures.append(str(MANIFEST))
        if failures:
            raise SystemExit("Windows bundle is stale: " + ", ".join(failures))
        print(f"Windows bundle verified: {len(WINDOWS_ARCHIVE_PATHS)} source-identical entries")
        return 0

    ARCHIVE.write_bytes(archive_body)
    MANIFEST.write_bytes(manifest_body)
    print(f"Windows bundle built: {len(WINDOWS_ARCHIVE_PATHS)} entries, sha256={digest(archive_body)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
