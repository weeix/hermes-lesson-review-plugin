from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _plugin_yaml_name() -> str:
    text = (ROOT / "plugin.yaml").read_text(encoding="utf-8")
    match = re.search(r"^name:\s*(\S+)\s*$", text, re.M)
    assert match, "plugin.yaml has no top-level name"
    return match.group(1)


def test_server_package_name_is_the_plugin_id():
    manifest = json.loads((ROOT / "dashboard" / "manifest.json").read_text(encoding="utf-8"))
    assert _plugin_yaml_name() == manifest["name"] == "lesson-review"
