"""Route-level tests: the plugin's FastAPI router mounted on a bare app (no Hermes middleware).

These cover the route rules (input validation, status codes, the decision gate) and need no Hermes
checkout. Auth, the plugin enable gate and profile scoping run in Hermes' own app and are covered by
tests/test_mounted.py (needs HERMES_SRC).
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

DASHBOARD = Path(__file__).resolve().parents[1] / "dashboard"
PREFIX = "/api/plugins/lesson-review"


def _load_plugin_api(monkeypatch, adapter_name: str):
    monkeypatch.setenv("LESSON_REVIEW_ADAPTER", adapter_name)
    sys.modules.pop("lesson_review_adapter", None)
    spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_lesson-review",
                                                  DASHBOARD / "plugin_api.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _client_for(mod) -> TestClient:
    app = FastAPI()
    app.include_router(mod.router, prefix=PREFIX)
    return TestClient(app)


@pytest.fixture
def client(monkeypatch):
    return _client_for(_load_plugin_api(monkeypatch, "fake"))


def test_list_returns_counts_gates_and_items(client):
    body = client.get(f"{PREFIX}/pending").json()
    assert body["counts"]["total"] == 8
    assert body["gates"]["memory"]["write_approval"] is True
    assert body["adapter"] == "fake"
    assert body["decisions_enabled"] is False
    assert len(body["items"]) == 8


def test_list_kind_filter_and_bad_kind(client):
    assert client.get(f"{PREFIX}/pending?kind=skills").json()["total"] == 4
    assert client.get(f"{PREFIX}/pending?kind=bogus").status_code == 400
    assert client.get(f"{PREFIX}/pending?page=0").status_code == 422
    second = client.get(f"{PREFIX}/pending?page=2").json()
    assert (second["page"], second["total"], second["items"]) == (2, 8, [])  # 8 fixtures fit on page 1


def test_preview_ok_and_404_and_400(client):
    ok = client.get(f"{PREFIX}/pending/memory/0a1d0002")
    assert ok.status_code == 200 and ok.json()["ops"][0]["subject"] == "memory"
    assert client.get(f"{PREFIX}/pending/memory/deadbeef").status_code == 404
    assert client.get(f"{PREFIX}/pending/memory/bad.id").status_code == 400
    assert client.get(f"{PREFIX}/pending/all/0a1d0001").status_code == 400


@pytest.mark.parametrize("bad_id", ["0A1D0001", "0a1d000", "0a1d00011", "0a1d000g", "0123%2E%2E"])
def test_malformed_ids_are_400(client, bad_id):
    assert client.get(f"{PREFIX}/pending/memory/{bad_id}").status_code == 400
    assert client.post(f"{PREFIX}/pending/memory/{bad_id}/approve").status_code == 400


@pytest.mark.parametrize("decision", ["approve", "reject"])
def test_fake_adapter_cannot_decide(client, decision):
    r = client.post(f"{PREFIX}/pending/memory/0a1d0001/{decision}", json={"expect": {}})
    assert r.status_code == 501
    assert r.json()["detail"] == "approve/reject are disabled for this profile"
    assert client.get(f"{PREFIX}/pending/memory/0a1d0001").json()["decisions_enabled"] is False


def test_unknown_decision_is_404(client):
    assert client.post(f"{PREFIX}/pending/memory/0a1d0001/delete").status_code == 404


class CoreProbe:
    """Stands in for CoreAdapter: named "core", records decisions."""

    name = "core"

    def __init__(self):
        self.calls = []

    def list_pending(self, kind, page):
        return {"kind": kind, "page": page, "items": []}

    def get_preview(self, kind, pid):
        return {"id": pid, "status": "ready"}

    def decide(self, kind, pid, decision, expect):
        self.calls.append((kind, pid, decision, expect))
        return {"status": "rejected"}


def _core_client(monkeypatch, config=None, *, config_error=None):
    """The router with a core adapter. ``config`` (or ``config_error``) is what Hermes'
    ``load_config_readonly`` answers; None leaves Hermes off the path, as in a bare checkout."""
    mod = _load_plugin_api(monkeypatch, "fake")
    probe = CoreProbe()
    monkeypatch.setattr(mod, "ADAPTER", probe)
    monkeypatch.delenv("LESSON_REVIEW_ALLOW_DECISIONS", raising=False)
    if config is not None or config_error is not None:
        def load_config_readonly():
            if config_error is not None:
                raise config_error
            return config
        hermes_cli = types.ModuleType("hermes_cli")
        hermes_config = types.ModuleType("hermes_cli.config")
        hermes_config.load_config_readonly = load_config_readonly
        hermes_cli.config = hermes_config
        monkeypatch.setitem(sys.modules, "hermes_cli", hermes_cli)
        monkeypatch.setitem(sys.modules, "hermes_cli.config", hermes_config)
    return _client_for(mod), probe


def _entry(**sections):
    return {"plugins": {"entries": {"lesson-review": sections}}}


def test_core_decisions_are_on_by_default_and_need_an_explicit_expect(monkeypatch):
    client, probe = _core_client(monkeypatch)
    url = f"{PREFIX}/pending/memory/0a1d0001/reject"
    token = {"profile": "sample-scope"}
    assert client.get(f"{PREFIX}/pending/memory/0a1d0001").json()["decisions_enabled"] is True
    assert client.post(url, json={}).status_code == 400
    assert probe.calls == []
    resp = client.post(url, json={"expect": token})
    assert resp.status_code == 200 and resp.json()["status"] == "rejected"
    assert probe.calls == [("memory", "0a1d0001", "reject", token)]


@pytest.mark.parametrize("config, enabled", [
    ({}, True),                                                              # no entry: the default
    (_entry(settings={}), True),
    (_entry(settings={"allow_decisions": True}), True),
    (_entry(settings={"allow_decisions": False}), False),
    (_entry(config={"allow_decisions": False}), False),                      # legacy subtree
    (_entry(settings={"allow_decisions": True}, config={"allow_decisions": False}), True),  # settings win
    (_entry(settings={"allow_decisions": "yes"}), False),                    # only a boolean true enables
    ({"plugins": {"entries": ["not", "a", "mapping"]}}, True),
])
def test_the_profile_setting_turns_decisions_on_or_off(monkeypatch, config, enabled):
    client, probe = _core_client(monkeypatch, config)
    assert client.get(f"{PREFIX}/pending").json()["decisions_enabled"] is enabled
    assert client.get(f"{PREFIX}/pending/memory/0a1d0001").json()["decisions_enabled"] is enabled
    r = client.post(f"{PREFIX}/pending/memory/0a1d0001/approve", json={"expect": {"profile": "p"}})
    assert r.status_code == (200 if enabled else 501)
    if not enabled:
        assert r.json()["detail"] == "approve/reject are disabled for this profile"
        assert probe.calls == []


def test_an_unreadable_config_turns_decisions_off(monkeypatch):
    client, probe = _core_client(monkeypatch, config_error=ValueError("broken config.yaml"))
    assert client.post(f"{PREFIX}/pending/memory/0a1d0001/approve", json={"expect": {}}).status_code == 501
    assert probe.calls == []


@pytest.mark.parametrize("value", ["0", "false", "No", " OFF "])
def test_the_environment_can_only_turn_decisions_off(monkeypatch, value):
    client, probe = _core_client(monkeypatch, _entry(settings={"allow_decisions": True}))
    monkeypatch.setenv("LESSON_REVIEW_ALLOW_DECISIONS", value)
    assert client.post(f"{PREFIX}/pending/memory/0a1d0001/approve", json={"expect": {}}).status_code == 501
    assert probe.calls == []


def test_the_environment_cannot_turn_decisions_on(monkeypatch):
    client, probe = _core_client(monkeypatch, _entry(settings={"allow_decisions": False}))
    monkeypatch.setenv("LESSON_REVIEW_ALLOW_DECISIONS", "1")
    assert client.post(f"{PREFIX}/pending/memory/0a1d0001/approve", json={"expect": {}}).status_code == 501
    assert probe.calls == []


def test_decision_with_bad_kind_or_id_is_400_not_501(client):
    assert client.post(f"{PREFIX}/pending/all/0a1d0001/approve").status_code == 400
    assert client.post(f"{PREFIX}/pending/skills/0a1d000/approve").status_code == 400


def test_bad_input_never_reaches_the_adapter(monkeypatch):
    """Validation runs in the route: any adapter call here fails the test."""
    mod = _load_plugin_api(monkeypatch, "fake")

    class Untouchable:
        name = "core"

        def __getattr__(self, attr):
            raise AssertionError(f"adapter.{attr} called for bad input")

    monkeypatch.setattr(mod, "ADAPTER", Untouchable())
    client = _client_for(mod)
    assert client.get(f"{PREFIX}/pending?kind=bogus").status_code == 400
    assert client.get(f"{PREFIX}/pending/all/0123abcd").status_code == 400
    assert client.get(f"{PREFIX}/pending/memory/0123ABCD").status_code == 400
    assert client.post(f"{PREFIX}/pending/memory/0123ABCD/approve", json={"expect": {}}).status_code == 400
    assert client.post(f"{PREFIX}/pending/nope/0123abcd/reject", json={"expect": {}}).status_code == 400
