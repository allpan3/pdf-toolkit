"""Package the Zotero extension without third-party dependencies."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "manifest.json").read_text())
zotero = manifest.get("applications", {}).get("zotero", {})
for field in ("id", "update_url", "strict_max_version"):
    if not zotero.get(field):
        raise SystemExit(f"Missing required manifest field: applications.zotero.{field}")
package = json.loads((root / "package.json").read_text())
if manifest["version"] != package["version"]:
    raise SystemExit("The manifest and package versions must match.")
destination = root / "dist" / f"pdf-toolkit-{manifest['version']}.xpi"
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
    for name in ("manifest.json", "bootstrap.js", "src/toolkit.js"):
        archive.write(root / name, name)
print(destination)
