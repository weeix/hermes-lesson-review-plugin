"""CoreAdapter's reshaping of core replies, run over the FakeAdapter fixtures. No Hermes checkout needed.

CoreAdapter against real core is covered through Hermes' own web app in tests/test_mounted.py.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD = ROOT / "dashboard"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


adapter = _load("lesson_review_adapter", DASHBOARD / "adapter.py")


def _fake():
    return adapter.FakeAdapter(now=1_000_000.0)


def test_list_counts_and_filtering():
    everything = _fake().list_pending("all", 1, page_size=100)
    assert everything["counts"] == {"memory": 4, "skills": 4, "total": 8} and everything["total"] == 8
    assert len(everything["items"]) == 8 and all(adapter.PENDING_ID_RE.fullmatch(i["id"]) for i in everything["items"])
    memory = _fake().list_pending("memory", 1, page_size=100)
    assert memory["total"] == 4 and all(i["kind"] == "memory" for i in memory["items"])


def test_pages_cover_every_write_once_and_clamp_the_page_size():
    fake = _fake()
    pages = [fake.list_pending("all", n, page_size=3)["items"] for n in (1, 2, 3)]
    assert [len(p) for p in pages] == [3, 3, 2]
    assert len({i["id"] for p in pages for i in p}) == 8
    assert fake.list_pending("all", 1, page_size=10_000)["page_size"] == 100


def test_list_wraps_gates_and_passes_needs_review_through():
    page = _fake().list_pending("all", 1)
    assert page["adapter"] == "fake"
    assert page["gates"] == {"memory": {"write_approval": True}, "skills": {"write_approval": True}}
    assert page["needs_review"] == {"memory": 0, "skills": 0, "total": 0}


def test_preview_reshapes_core_ops_for_the_pane():
    single = _fake().get_preview("memory", "0a1d0002")
    assert (single["is_batch"], single["op_count"], single["action"]) == (False, 1, "replace")
    assert single["created_at"] == 1_000_000.0 - 2400  # core's preview carries the staging time
    [op] = single["ops"]
    assert (op["index"], op["subject"], op["diff"]) == (1, "memory", None)
    assert op["fields"] == {"matched_entry": "Staging DB: pg-staging-1 (old cluster, retiring)",
                            "old_text": "Staging DB: pg-staging-1", "content": "Staging DB: pg-staging-2 (new cluster)"}
    batch = _fake().get_preview("skills", "5c1e0004")
    assert (batch["is_batch"], batch["op_count"], batch["action"]) == (True, 3, "batch")
    assert [(op["index"], op["action"], op["subject"]) for op in batch["ops"]] == [
        (1, "create", "release-notes"), (2, "patch", "release-notes"), (3, "write_file", "release-notes")]
    assert "+Use tags." in batch["ops"][1]["diff"]
    assert "gist" not in batch["ops"][0]["fields"]  # only the fields the pane shows


def test_a_write_core_cannot_preview_is_none():
    fake = _fake()
    assert fake.get_preview("memory", "deadbeef") is None
    missing = fake._preview_write("memory", "deadbeef")  # core's reply for an id with no pending record
    assert missing["created_at"] is None and missing["expect"] is None
    assert set(missing) == {"id", "subsystem", "status", "reason", "summary", "origin", "created_at", "ops",
                            "changed_since_staged", "notice", "expect"}


def test_store_errors_become_store_refused():
    class Broken(adapter.CoreAdapter):
        def _service(self):
            def fail(*args, **kwargs):
                raise OSError("disk")
            return fail, fail, fail

    for call in (lambda a: a.list_pending("all"), lambda a: a.get_preview("memory", "0a1d0001"),
                 lambda a: a.decide("memory", "0a1d0001", "reject", {})):
        with pytest.raises(adapter.StoreRefusedError):
            call(Broken())
