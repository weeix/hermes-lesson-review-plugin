"""Probe for tests/test_mounted.py: runs requests against Hermes' real web app, in a fresh process.

Run by the test with a Hermes interpreter (HERMES_PYTHON), never imported by pytest itself: Hermes
reads its environment (HOME, HERMES_HOME, the session token) at import, so each scenario gets its own
process with a throwaway home.

    python tests/mounted_probe.py <spec.json> <result.json>

spec: {"hermes_src": str, "home": str, "token": str|null,
       "requests": [{"name": str, "method": str, "path": str, "token": bool, "expect_from": str?}]}
       ``expect_from`` names an earlier preview request; its ``expect`` value becomes this request's
       JSON body. Decisions follow each profile's config; the env override is cleared.
result: {"<name>": {"status": int, "body": any}}   (body: parsed JSON, or text)
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def main() -> int:
    spec_path, result_path = Path(sys.argv[1]), Path(sys.argv[2])
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    home = Path(spec["home"])
    # Everything Hermes resolves from the environment points inside the throwaway home.
    os.environ["HOME"] = str(home)
    os.environ["HERMES_HOME"] = str(home / ".hermes")
    os.environ.pop("LESSON_REVIEW_ADAPTER", None)
    os.environ.pop("LESSON_REVIEW_ALLOW_DECISIONS", None)
    if spec.get("token"):
        os.environ["HERMES_DASHBOARD_SESSION_TOKEN"] = spec["token"]
    else:
        os.environ.pop("HERMES_DASHBOARD_SESSION_TOKEN", None)
    sys.path.insert(0, spec["hermes_src"])

    from fastapi.testclient import TestClient
    from hermes_cli.web_server import app

    results: dict[str, dict] = {}
    client = TestClient(app)
    for req in spec["requests"]:
        headers = {}
        if req.get("token") and spec.get("token"):
            headers["X-Hermes-Session-Token"] = spec["token"]
        body = None
        if earlier := req.get("expect_from"):
            body = {"expect": results[earlier]["body"]["expect"]}
        response = client.request(req["method"], req["path"], headers=headers, json=body)
        try:
            body = response.json()
        except ValueError:
            body = response.text
        results[req["name"]] = {"status": response.status_code, "body": body}
    result_path.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
