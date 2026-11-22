"""Writes tests/render/.generated/snapshot.json for the render smoke test (run.mjs) without a server.

The responses are the plugin's own routes over the FakeAdapter fixtures, run in-process with FastAPI's
TestClient (no socket, no background process). The paths written here are the ones run.mjs requests;
run.mjs fails loudly when one is missing.

    .venv/bin/python tests/render/make-snapshot.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / ".generated" / "snapshot.json"
PREFIX = "/api/plugins/lesson-review"


def load_routes(adapter_name: str):
    os.environ["LESSON_REVIEW_ADAPTER"] = adapter_name
    sys.modules.pop("lesson_review_adapter", None)
    spec = importlib.util.spec_from_file_location("lesson_review_snapshot_api", ROOT / "dashboard" / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    mod = load_routes("fake")
    app = FastAPI()
    app.include_router(mod.router, prefix=PREFIX)
    client = TestClient(app)

    snapshot: dict[str, object] = {}

    def fetch(path: str):
        r = client.get(PREFIX + path)
        if r.status_code != 200:
            raise SystemExit(f"{path} -> {r.status_code} {r.text}")
        snapshot[PREFIX + path] = r.json()
        return snapshot[PREFIX + path]

    everything = fetch("/pending?kind=all")
    batch = next((i for i in everything["items"] if i["is_batch"] and i["kind"] == "skills"), None)
    single = next((i for i in everything["items"] if i["kind"] == "memory" and not i["is_batch"]), None)
    if batch is None or single is None:
        raise SystemExit("the store needs one skills batch and one single memory record")
    fetch(f"/pending/skills/{batch['id']}")
    fetch(f"/pending/memory/{single['id']}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(snapshot, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {OUT} ({len(snapshot)} responses)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
