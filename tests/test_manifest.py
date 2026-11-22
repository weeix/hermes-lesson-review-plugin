"""Naming contract: the server package and the desktop half show the same name.

Desktop's Plugins page shows the agent row's manifest name (plugin.yaml ``name``) and, for a paired
desktop half, the desktop plugin's ``name``. This plugin keeps all three equal so the two cards read
as one package (see README "Names"). The desktop half's name is checked on the imported plugin object
by tests/render/run.mjs. No Hermes checkout needed.
"""

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
