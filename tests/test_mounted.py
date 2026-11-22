"""Mounted HTTP tests: the plugin's routes served by Hermes' own web app (hermes_cli.web_server.app).

Unlike test_routes.py (a bare router), these go through Hermes' middleware: the session-token auth
gate, the plugin enable gate, and the ``?profile=`` scope. They need a hermes-agent checkout and an
interpreter that can import it:

    HERMES_SRC=/path/to/hermes-agent HERMES_PYTHON=/path/to/hermes/python .venv/bin/python -m pytest -q \
        tests/test_mounted.py

HERMES_PYTHON defaults to the running interpreter. Each scenario runs tests/mounted_probe.py in a fresh
process whose HOME and HERMES_HOME are a throwaway tree under pytest's temp dir (TMPDIR). The real
~/.hermes is never used: the probe pins both.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PROBE = ROOT / "tests" / "mounted_probe.py"
HERMES_SRC = os.environ.get("HERMES_SRC", "")
HERMES_PYTHON = os.environ.get("HERMES_PYTHON") or sys.executable
TOKEN = "wr-throwaway-session-token"  # a process-local value; no credential is involved
PREFIX = "/api/plugins/lesson-review"
COLLIDING_ID = "0a0a0a0a"  # the same record id in the launch home and in both profiles
ALPHA_ONLY_ID = "0a1a1a1a"
STOPPED_ID = "0b0b0b0b"  # an approval that stopped partway (needs_review)

pytestmark = pytest.mark.skipif(not HERMES_SRC, reason="set HERMES_SRC to a hermes-agent checkout")


def _record(content: str, created_at: float) -> str:
    return json.dumps({"id": "ignored-inside", "subsystem": "memory", "action": "add", "summary": content,
                       "origin": "foreground", "created_at": created_at,
                       "payload": {"action": "add", "target": "user", "content": content}})


def _config(*, plugin_enabled: bool, write_approval: bool = False, allow_decisions: bool | None = None) -> str:
    # JSON is valid YAML; the file is read by Hermes' YAML loader like any config.yaml.
    entries = {} if allow_decisions is None else {"lesson-review": {"settings": {"allow_decisions": allow_decisions}}}
    cfg = {
        "plugins": {"enabled": ["lesson-review"] if plugin_enabled else [], "disabled": [], "entries": entries},
        "memory": {"write_approval": write_approval},
        "skills": {"write_approval": False},
    }
    return json.dumps(cfg)


def _make_home(base: Path, *, launch_plugin_enabled: bool) -> Path:
    """A throwaway HOME with a Hermes home at ``<home>/.hermes``: the launch profile, named profiles
    ``alpha`` (plugin on, memory gate on, decisions on by default), ``beta`` (plugin on, colliding id,
    no alpha-only record, ``allow_decisions: false``), ``off`` (plugin not enabled in that profile)."""
    home = base / "home"
    hermes = home / ".hermes"
    (hermes / "plugins").mkdir(parents=True)
    os.symlink(ROOT, hermes / "plugins" / "lesson-review", target_is_directory=True)
    (hermes / "config.yaml").write_text(_config(plugin_enabled=launch_plugin_enabled), encoding="utf-8")
    _put(hermes, COLLIDING_ID, "ROOT", 100.0)

    profiles = hermes / "profiles"
    for name, enabled, approval, decisions in (("alpha", True, True, None), ("beta", True, False, False),
                                               ("off", False, False, None)):
        profile = profiles / name
        profile.mkdir(parents=True)
        (profile / "config.yaml").write_text(
            _config(plugin_enabled=enabled, write_approval=approval, allow_decisions=decisions), encoding="utf-8")
    _put(profiles / "alpha", COLLIDING_ID, "ALPHA", 200.0)
    _put(profiles / "alpha", ALPHA_ONLY_ID, "ALPHA-ONLY", 300.0)
    _put(profiles / "beta", COLLIDING_ID, "BETA", 200.0)
    return home


def _put(home_dir: Path, rec_id: str, content: str, created_at: float) -> None:
    folder = home_dir / "pending" / "memory"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{rec_id}.json").write_text(_record(content, created_at), encoding="utf-8")


def _put_stopped_approval(hermes: Path) -> None:
    """A write whose approval stopped mid-write, as core's own test builds it: the record moved to
    ``.claimed`` with an ``applying`` outcome and no live decision. Core reports it as needs_review."""
    (hermes / "pending" / "memory" / f"{STOPPED_ID}.claimed").write_text(_record("STOPPED", 150.0), encoding="utf-8")
    resolved = hermes / "pending" / "resolved" / "memory"
    resolved.mkdir(parents=True)
    (resolved / f"{STOPPED_ID}.json").write_text(
        json.dumps({"id": STOPPED_ID, "subsystem": "memory", "status": "applying", "decided_at": 160.0}), encoding="utf-8")


def _probe(base: Path, home: Path, requests: list[dict]) -> dict:
    spec_path, result_path = base / "spec.json", base / "result.json"
    spec_path.write_text(json.dumps({"hermes_src": HERMES_SRC, "home": str(home), "token": TOKEN,
                                     "requests": requests}), encoding="utf-8")
    # Keep PYTHONPATH: on some hosts it is the only route to Hermes' dependencies. Drop the variables that
    # would pin another home or token; the probe sets its own.
    env = {k: v for k, v in os.environ.items() if k not in ("HERMES_HOME", "HERMES_DASHBOARD_SESSION_TOKEN",
                                                             "LESSON_REVIEW_ADAPTER", "LESSON_REVIEW_ALLOW_DECISIONS")}
    # No .pyc is written into the Hermes checkout or the installed environment.
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    proc = subprocess.run([HERMES_PYTHON, str(PROBE), str(spec_path), str(result_path)],
                          capture_output=True, text=True, env=env, timeout=900)
    if proc.returncode != 0:
        pytest.fail(f"mounted probe failed (exit {proc.returncode}):\n{proc.stderr[-4000:]}")
    return json.loads(result_path.read_text(encoding="utf-8"))


def _get(name: str, path: str, *, token: bool = True) -> dict:
    return {"name": name, "method": "GET", "path": PREFIX + path, "token": token}


@pytest.fixture(scope="module")
def launch_results(tmp_path_factory):
    """Launch home with the plugin enabled: auth, profile scoping, the decision gate, needs_review."""
    base = tmp_path_factory.mktemp("mounted-enabled")
    home = _make_home(base, launch_plugin_enabled=True)
    _put_stopped_approval(home / ".hermes")
    requests = [
        _get("no_token", "/pending", token=False),
        _get("root_list", "/pending?kind=memory"),
        _get("root_skills", "/pending?kind=skills"),
        _get("root_preview", f"/pending/memory/{COLLIDING_ID}"),
        _get("alpha_list", "/pending?kind=memory&profile=alpha"),
        _get("alpha_preview", f"/pending/memory/{COLLIDING_ID}?profile=alpha"),
        _get("alpha_only_in_beta", f"/pending/memory/{ALPHA_ONLY_ID}?profile=beta"),
        _get("beta_list", "/pending?kind=memory&profile=beta"),
        _get("beta_preview", f"/pending/memory/{COLLIDING_ID}?profile=beta"),
        _get("alpha_no_token", "/pending?kind=memory&profile=alpha", token=False),
        _get("off_profile", "/pending?kind=memory&profile=off"),
        _get("missing_profile", "/pending?kind=memory&profile=missing"),
        {"name": "decision", "method": "POST", "path": PREFIX + f"/pending/memory/{COLLIDING_ID}/approve",
         "token": True},
        {"name": "bad_kind", "method": "GET", "path": PREFIX + "/pending/bogus/" + COLLIDING_ID, "token": True},
    ]
    results = _probe(base, home, requests)
    results["_home"] = str(home)
    return results


@pytest.fixture(scope="module")
def disabled_results(tmp_path_factory):
    """Launch home without the plugin in plugins.enabled: the plugin is off on this Hermes."""
    base = tmp_path_factory.mktemp("mounted-disabled")
    home = _make_home(base, launch_plugin_enabled=False)
    requests = [
        _get("no_token", "/pending", token=False),
        _get("list", "/pending?kind=memory"),
        _get("preview", f"/pending/memory/{COLLIDING_ID}"),
    ]
    return _probe(base, home, requests)


def _ids(body: dict) -> list[str]:
    return [item["id"] for item in body["items"]]


def test_unauthenticated_request_is_401(launch_results):
    assert launch_results["no_token"]["status"] == 401
    assert launch_results["alpha_no_token"]["status"] == 401


def test_authenticated_list_and_preview_are_served(launch_results):
    listed = launch_results["root_list"]
    assert listed["status"] == 200
    assert listed["body"]["counts"]["memory"] == 1 and _ids(listed["body"]) == [COLLIDING_ID]
    preview = launch_results["root_preview"]
    assert preview["status"] == 200 and preview["body"]["ops"][0]["fields"]["content"] == "ROOT"
    assert listed["body"]["adapter"] == "core" and "ROOT" not in str(listed["body"])


def test_decisions_are_on_by_default_through_hermes(launch_results):
    assert launch_results["root_preview"]["body"]["decisions_enabled"] is True
    assert launch_results["alpha_preview"]["body"]["decisions_enabled"] is True
    assert launch_results["beta_preview"]["body"]["decisions_enabled"] is False  # allow_decisions: false
    # On, but a decision without the preview's expect value is refused before core is asked.
    assert launch_results["decision"]["status"] == 400


def test_bad_kind_is_400_through_hermes(launch_results):
    assert launch_results["bad_kind"]["status"] == 400


def test_profiles_are_isolated_with_colliding_ids(launch_results):
    """Same record id in the launch home and in two profiles: each scope sees only its own record."""
    root, alpha, beta = launch_results["root_preview"], launch_results["alpha_preview"], launch_results["beta_preview"]
    assert root["body"]["ops"][0]["fields"]["content"] == "ROOT"
    assert alpha["status"] == 200 and alpha["body"]["ops"][0]["fields"]["content"] == "ALPHA"
    assert beta["status"] == 200 and beta["body"]["ops"][0]["fields"]["content"] == "BETA"
    # Each preview carries its own record's staging time, as a float.
    assert [r["body"]["created_at"] for r in (root, alpha, beta)] == [100.0, 200.0, 200.0]

    assert _ids(launch_results["alpha_list"]["body"]) == [COLLIDING_ID, ALPHA_ONLY_ID]
    assert _ids(launch_results["beta_list"]["body"]) == [COLLIDING_ID]
    assert launch_results["alpha_only_in_beta"]["status"] == 404  # alpha's record is not visible from beta


def test_each_profile_has_its_own_scope_and_gates(launch_results):
    scopes = {
        "root": launch_results["root_list"]["body"]["scope"],
        "alpha": launch_results["alpha_list"]["body"]["scope"],
        "beta": launch_results["beta_list"]["body"]["scope"],
    }
    assert len(set(scopes.values())) == 3, scopes
    for profile, scope in scopes.items():
        assert isinstance(scope, str) and scope
        assert launch_results["_home"] not in scope
        assert launch_results[f"{profile}_preview"]["body"]["expect"]["profile"] == scope
    assert launch_results["alpha_list"]["body"]["gates"]["memory"]["write_approval"] is True
    assert launch_results["beta_list"]["body"]["gates"]["memory"]["write_approval"] is False


def test_plugin_disabled_in_a_profile_is_404(launch_results):
    r = launch_results["off_profile"]
    assert r["status"] == 404 and r["body"] == {"detail": "Plugin not found"}


def test_mounted_decision_uses_auth_profile_and_core_outcome(tmp_path):
    home = _make_home(tmp_path, launch_plugin_enabled=True)
    url = PREFIX + f"/pending/memory/{COLLIDING_ID}/approve"
    results = _probe(tmp_path, home, [
        _get("before", f"/pending/memory/{COLLIDING_ID}"),
        {"name": "no_auth", "path": url, "method": "POST", "token": False, "expect_from": "before"},
        {"name": "wrong_profile", "path": url + "?profile=alpha", "method": "POST", "token": True,
         "expect_from": "before"},
        {"name": "first", "path": url, "method": "POST", "token": True, "expect_from": "before"},
        {"name": "retry", "path": url, "method": "POST", "token": True, "expect_from": "before"},
    ])
    assert results["before"]["body"]["decisions_enabled"] is True
    assert results["no_auth"]["status"] == 401
    assert results["wrong_profile"]["body"]["status"] == "conflict"
    assert results["first"]["body"]["status"] == "applied"
    assert results["retry"]["body"]["status"] == "already_resolved"
    hermes = home / ".hermes"
    assert "ROOT" in (hermes / "memories" / "USER.md").read_text(encoding="utf-8")
    assert not (hermes / "profiles" / "alpha" / "memories" / "USER.md").exists()


def test_a_read_only_profile_cannot_decide_while_another_can(tmp_path):
    """alpha keeps the default (decisions on); beta set ``allow_decisions: false``. Same record id in both."""
    home = _make_home(tmp_path, launch_plugin_enabled=True)
    path = f"/pending/memory/{COLLIDING_ID}"
    results = _probe(tmp_path, home, [
        _get("alpha_before", path + "?profile=alpha"),
        _get("beta_before", path + "?profile=beta"),
        {"name": "beta_approve", "path": PREFIX + path + "/approve?profile=beta", "method": "POST", "token": True,
         "expect_from": "beta_before"},
        {"name": "beta_reject", "path": PREFIX + path + "/reject?profile=beta", "method": "POST", "token": True,
         "expect_from": "beta_before"},
        {"name": "alpha_approve", "path": PREFIX + path + "/approve?profile=alpha", "method": "POST", "token": True,
         "expect_from": "alpha_before"},
        _get("beta_after", "/pending?kind=memory&profile=beta"),
    ])
    assert results["alpha_before"]["body"]["decisions_enabled"] is True
    assert results["beta_before"]["body"]["decisions_enabled"] is False
    for name in ("beta_approve", "beta_reject"):
        assert results[name]["status"] == 501
        assert results[name]["body"]["detail"] == "approve/reject are disabled for this profile"
    assert results["alpha_approve"]["status"] == 200 and results["alpha_approve"]["body"]["status"] == "applied"
    assert _ids(results["beta_after"]["body"]) == [COLLIDING_ID]  # beta's write is still pending
    profiles = home / ".hermes" / "profiles"
    assert "ALPHA" in (profiles / "alpha" / "memories" / "USER.md").read_text(encoding="utf-8")
    assert not (profiles / "beta" / "memories" / "USER.md").exists()


def test_a_write_that_needs_review_is_counted_apart_from_the_queue(launch_results):
    """An approval that stopped partway: core counts it under ``needs_review`` (both kinds, whatever the
    filter), never in ``items`` or ``counts``, and only in its own profile."""
    for name in ("root_list", "root_skills"):
        body = launch_results[name]["body"]
        assert body["needs_review"] == {"memory": 1, "skills": 0, "total": 1}, body
        assert body["counts"] == {"memory": 1, "skills": 0, "total": 1}  # the queued write only
        assert STOPPED_ID not in _ids(body) and "STOPPED" not in json.dumps(body)
    assert launch_results["beta_list"]["body"]["needs_review"] == {"memory": 0, "skills": 0, "total": 0}


def test_a_linked_pending_store_is_409_through_hermes(tmp_path):
    """A planted link at ``pending/memory`` is refused by core, not read through and not shown as empty."""
    home = _make_home(tmp_path, launch_plugin_enabled=True)
    memory = home / ".hermes" / "pending" / "memory"
    elsewhere = tmp_path / "elsewhere"
    memory.rename(elsewhere)
    os.symlink(elsewhere, memory, target_is_directory=True)
    results = _probe(tmp_path, home, [
        _get("list", "/pending?kind=memory"),
        _get("preview", f"/pending/memory/{COLLIDING_ID}"),
    ])
    assert results["list"]["status"] == 409, results["list"]
    assert results["preview"]["status"] == 409, results["preview"]
    assert "ROOT" not in json.dumps(results)


def test_unknown_profile_is_404(launch_results):
    assert launch_results["missing_profile"]["status"] == 404


def test_plugin_not_enabled_on_this_hermes_is_404(disabled_results):
    r = disabled_results["list"]
    assert r["status"] == 404 and r["body"] == {"detail": "Plugin not found"}
    assert disabled_results["preview"]["status"] == 404


def test_auth_comes_before_the_enable_gate(disabled_results):
    assert disabled_results["no_token"]["status"] == 401
