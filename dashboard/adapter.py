"""Adapters between the lesson-review routes and Hermes core.

    list_pending(kind, page)      -> dict   (one page of items, per-kind counts, gates, needs_review)
    get_preview(kind, pending_id) -> dict | None
    decide(kind, pending_id, decision, expect) -> dict

``CoreAdapter`` is the production adapter. It calls the public ``tools.write_review_api`` service,
which resolves the request's profile and owns the pending store (id format, link and file-type
checks). ``FakeAdapter`` is the same adapter over fixture replies in core's shape, for development
and the render tests; the routes never let it decide.
"""

from __future__ import annotations

import re
import time
from contextlib import contextmanager
from typing import Any, Optional

KINDS = ("memory", "skills")
DEFAULT_PAGE_SIZE = 25
#: How core mints a pending id (``uuid4().hex[:8]``). Routes refuse any other id before a lookup.
PENDING_ID_RE = re.compile(r"[0-9a-f]{8}")
#: The op fields the pane shows, from core's memory and skill op previews.
_OP_FIELDS = ("matched_entry", "old_text", "content", "file_path", "blocker")


class StoreRefusedError(RuntimeError):
    """Core could not read or update the profile's pending store. Routes map it to HTTP 409."""


class CoreUnavailableError(RuntimeError):
    """This host does not publish the Write Review API yet."""


@contextmanager
def _store_errors(message: str):
    try:
        yield
    except (OSError, ValueError) as exc:
        raise StoreRefusedError(message) from exc


class CoreAdapter:
    name = "core"

    def _service(self):
        try:
            from tools.write_review_api import decide_write, list_writes, preview_write
        except ImportError as exc:
            raise CoreUnavailableError("This Hermes build does not provide the Write Review API.") from exc
        return list_writes, preview_write, decide_write

    def list_pending(self, kind="all", page=1, page_size=DEFAULT_PAGE_SIZE):
        list_writes, _, _ = self._service()
        with _store_errors("The profile's pending store could not be read."):
            result = list_writes(kind, page=page, page_size=page_size)
        return {**result, "adapter": self.name,
                "gates": {k: {"write_approval": enabled} for k, enabled in result["gates"].items()}}

    def get_preview(self, kind, pending_id):
        _, preview_write, _ = self._service()
        with _store_errors("The profile's pending store could not be read."):
            result = preview_write(kind, pending_id)
        if result["status"] == "conflict" and not result.get("expect"):
            return None
        ops = result["ops"]
        return {**result, "kind": kind, "is_batch": len(ops) > 1, "op_count": len(ops),
                "action": ops[0]["action"] if len(ops) == 1 else "batch" if ops else "write",
                "ops": [{"index": i, "action": op["action"], "subject": op.get("name") or op.get("target"),
                         "fields": {k: op[k] for k in _OP_FIELDS if k in op}, "diff": op.get("diff")}
                        for i, op in enumerate(ops, 1)]}

    def decide(self, kind, pending_id, decision, expect):
        _, _, decide_write = self._service()
        with _store_errors("The profile's pending store could not be updated."):
            return decide_write(kind, pending_id, decision, expect=expect)


class FakeAdapter(CoreAdapter):
    """CoreAdapter over eight fixture writes (memory add/replace/remove, a memory batch, skill
    create/patch/delete, a three-op skill batch), in core's list and preview reply shapes."""

    name = "fake"

    def __init__(self, now: Optional[float] = None) -> None:
        self._writes = _fixture_writes(time.time() if now is None else now)

    def _service(self):
        return self._list_writes, self._preview_write, None

    def _list_writes(self, kind, *, page, page_size):
        page, page_size = max(1, page), max(1, min(page_size, 100))
        counts = {k: sum(1 for w in self._writes if w["item"]["kind"] == k) for k in KINDS}
        counts["total"] = sum(counts.values())
        selected = sorted((w["item"] for w in self._writes if kind in ("all", w["item"]["kind"])),
                          key=lambda item: item["created_at"])
        return {"kind": kind, "scope": "fixture", "page": page, "page_size": page_size, "total": len(selected),
                "counts": counts, "needs_review": {"memory": 0, "skills": 0, "total": 0},
                "gates": {k: True for k in KINDS}, "items": selected[(page - 1) * page_size:page * page_size]}

    def _preview_write(self, kind, pending_id):
        for w in self._writes:
            item = w["item"]
            if (item["kind"], item["id"]) == (kind, pending_id):
                return {"id": pending_id, "subsystem": kind, "status": "ready", "reason": None,
                        "summary": item["summary"], "origin": item["origin"], "created_at": item["created_at"],
                        "ops": w["ops"], "changed_since_staged": [], "notice": None,
                        "expect": {"review_kind": kind, "review_id": pending_id}}
        return {"id": pending_id, "subsystem": kind, "status": "conflict",
                "reason": f"no pending {kind} write with id '{pending_id}'.", "summary": "", "origin": "",
                "created_at": None, "ops": [], "changed_since_staged": [], "notice": None, "expect": None}


def _fixture_writes(now: float) -> list[dict[str, Any]]:
    def write(kind, pid, action, age, origin, ops):
        item = {"kind": kind, "id": pid, "action": action, "created_at": now - age, "origin": origin,
                "summary": f"{'Memory' if kind == 'memory' else 'Skill'} {action}",
                "is_batch": action == "batch", "op_count": len(ops)}
        return {"item": item, "ops": ops}

    def mem(action, content="", old_text="", matched_entry=None, target="memory"):
        return {"action": action, "target": target, "content": content, "old_text": old_text,
                "matched_entry": matched_entry}

    def skill(action, name, file_path=None, diff=None):
        return {"action": action, "name": name, "file_path": file_path, "gist": "", "diff": diff, "blocker": None}

    return [
        write("memory", "0a1d0001", "add", 3600, "foreground",
              [mem("add", "Prefers terse status updates.", target="user")]),
        write("memory", "0a1d0002", "replace", 2400, "foreground",
              [mem("replace", "Staging DB: pg-staging-2 (new cluster)", "Staging DB: pg-staging-1",
                   "Staging DB: pg-staging-1 (old cluster, retiring)")]),
        write("memory", "0a1d0003", "remove", 1200, "background_review",
              [mem("remove", old_text="Repo lives in ~/src/old-app", matched_entry="Repo lives in ~/src/old-app")]),
        write("memory", "0a1d0004", "batch", 600, "background_review",
              [mem("replace", "CI is per-head.", "ci per HEAD.", "RULE B: ci per HEAD."),
               mem("remove", old_text="Old Slack webhook URL", matched_entry="Old Slack webhook URL")]),
        write("skills", "5c1e0001", "create", 3000, "foreground", [skill(
            "create", "deploy-runbook", "SKILL.md",
            "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -0,0 +1,4 @@\n+---\n+name: deploy-runbook\n"
            "+description: Use when shipping a release to staging or prod.\n+---")]),
        write("skills", "5c1e0002", "patch", 900, "background_review", [skill(
            "patch", "git-review", "SKILL.md",
            "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -3 +3 @@\n-Squash before merge.\n+Never squash; keep history.")]),
        write("skills", "5c1e0003", "delete", 300, "foreground", [skill("delete", "old-cron-helper")]),
        write("skills", "5c1e0004", "batch", 120, "background_review", [
            skill("create", "release-notes", "SKILL.md",
                  "--- a/SKILL.md\n+++ b/SKILL.md\n@@ -0,0 +1,3 @@\n+---\n+name: release-notes\n+---"),
            skill("patch", "release-notes", "SKILL.md",
                  "--- before\n+++ after\n@@ -1,3 +1,5 @@\n ---\n name: release-notes\n ---\n+\n+Use tags."),
            skill("write_file", "release-notes", "templates/entry.md",
                  "--- a/templates/entry.md\n+++ b/templates/entry.md\n@@ -0,0 +1,2 @@\n+## {version}\n+- {changes}"),
        ]),
    ]


def select_adapter(name: str) -> CoreAdapter:
    """Only the core service is a production adapter; fake is fixture data."""
    if name == "fake":
        return FakeAdapter()
    if name in ("", "core"):
        return CoreAdapter()
    raise ValueError(f"unknown LESSON_REVIEW_ADAPTER {name!r}; expected 'core' or 'fake'")
