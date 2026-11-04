"""Move GP Sync to the newest gpmc and dependencies.

Prints what changed (for release notes), or nothing. It does not release anything:
the workflow then runs ruff and every test, and builds and releases a new image
only if they all pass.
"""

import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
PYPROJECT = BACKEND / "pyproject.toml"
LOCK = BACKEND / "uv.lock"
WEB = ROOT / "web"
PACKAGE_JSON = WEB / "package.json"


def locked_versions():
    return dict(re.findall(r'\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"', LOCK.read_text()))


def npm_view(spec, field="version"):
    out = subprocess.run(["npm", "view", spec, field, "--json"], cwd=WEB, capture_output=True, text=True, check=True)
    value = json.loads(out.stdout or "null")
    return value[-1] if isinstance(value, list) else value


def update_web():
    """Newest dashboard packages within the same major version (a new major needs a person)."""
    pkg = json.loads(PACKAGE_JSON.read_text())
    changes = []
    for group in ("dependencies", "devDependencies"):
        for name, current in pkg.get(group, {}).items():
            major = current.split(".")[0]
            latest = npm_view(f"{name}@^{major}") or current
            if latest != current:
                pkg[group][name] = latest
                changes.append(f"{name} {current} -> {latest}")
    # Vite+ needs `vite` aliased to its own core and Vitest pinned to the version it bundles.
    vp = pkg["devDependencies"]["vite-plus"]
    pkg["overrides"] = {
        "vite": f"npm:@voidzero-dev/vite-plus-core@{vp}",
        "vitest": npm_view(f"vite-plus@{vp}", "dependencies.vitest"),
    }
    PACKAGE_JSON.write_text(json.dumps(pkg, indent=2) + "\n")
    subprocess.run(["npm", "install", "--no-audit", "--no-fund"], cwd=WEB, check=True, stdout=sys.stderr)
    return changes


def main():
    text = PYPROJECT.read_text()
    current = re.search(r'"gpmc==([^"]+)"', text).group(1)
    with urllib.request.urlopen("https://pypi.org/pypi/gpmc/json", timeout=60) as r:
        latest = json.load(r)["info"]["version"]
    if latest != current:
        PYPROJECT.write_text(text.replace(f'"gpmc=={current}"', f'"gpmc=={latest}"'))

    before = locked_versions()
    subprocess.run(["uv", "lock", "--upgrade"], cwd=BACKEND, check=True, stdout=sys.stderr)
    after = locked_versions()
    changes = [f"{n} {before.get(n, 'new')} -> {v}" for n, v in sorted(after.items()) if before.get(n) != v]
    changes += update_web()
    print(", ".join(changes))


if __name__ == "__main__":
    main()
