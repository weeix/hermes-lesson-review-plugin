"""Backend routes for the lesson-review plugin, mounted at /api/plugins/lesson-review/.

Auth and profile scoping are done by Hermes before this code runs (dashboard auth gate, then the
``?profile=`` / native-grant scope). Core's service reads the profile the request is scoped to.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from collections.abc import Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query


def _load_adapter_module():
    """Hermes loads this file by path, without a package for relative imports."""
    name = "lesson_review_adapter"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).resolve().with_name("adapter.py")
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(name, None)
        raise
    return module


_adapter_mod = _load_adapter_module()
ADAPTER = _adapter_mod.select_adapter(os.environ.get("LESSON_REVIEW_ADAPTER", "core").strip().lower())
DECISIONS = ("approve", "reject")
PLUGIN_ID = "lesson-review"
# desktop/plugin.js listens for plugin.lesson-review.pending.changed (PUSH_EVENTS).
PENDING_CHANGED_EVENT = "pending.changed"
_OFF_VALUES = frozenset({"0", "false", "no", "off"})

router = APIRouter()


def _mapping(value: Any) -> Mapping:
    return value if isinstance(value, Mapping) else {}


def _decisions_enabled() -> bool:
    """Follow ``ctx.get_config`` precedence for the request's profile."""
    if ADAPTER.name != "core":
        return False
    if os.environ.get("LESSON_REVIEW_ALLOW_DECISIONS", "").strip().lower() in _OFF_VALUES:
        return False
    try:
        from hermes_cli.config import load_config_readonly
    except ImportError:  # a bare router with no Hermes on the path (the route tests)
        return True
    try:
        config = load_config_readonly()
    except Exception:
        return False
    plugins = _mapping(_mapping(config).get("plugins"))
    entries = _mapping(plugins.get("entries"))
    entry = _mapping(entries.get(PLUGIN_ID))
    for section in ("settings", "config"):
        values = _mapping(entry.get(section))
        if "allow_decisions" in values:
            return values["allow_decisions"] is True
    return True


def _require_kind(kind: str, *, allow_all: bool) -> None:
    allowed = ("all", *_adapter_mod.KINDS) if allow_all else _adapter_mod.KINDS
    if kind not in allowed:
        raise HTTPException(status_code=400, detail=f"unknown kind {kind!r}; expected one of {', '.join(allowed)}")


def _require_id(pending_id: str) -> None:
    if not _adapter_mod.PENDING_ID_RE.fullmatch(pending_id or ""):
        raise HTTPException(status_code=400, detail="malformed pending id: expected 8 lowercase hex characters")


@contextmanager
def _adapter_errors():
    try:
        yield
    except _adapter_mod.CoreUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except _adapter_mod.StoreRefusedError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/pending")
def list_pending(kind: str = Query("all"), page: int = Query(1, ge=1)) -> dict:
    _require_kind(kind, allow_all=True)
    with _adapter_errors():
        result = ADAPTER.list_pending(kind, page)
    return {**result, "decisions_enabled": _decisions_enabled()}


@router.get("/pending/{kind}/{pending_id}")
def get_pending(kind: str, pending_id: str) -> dict:
    _require_kind(kind, allow_all=False)
    _require_id(pending_id)
    with _adapter_errors():
        record = ADAPTER.get_preview(kind, pending_id)
    if record is None:
        raise HTTPException(status_code=404, detail="no such pending write")
    return {**record, "decisions_enabled": _decisions_enabled()}


@router.post("/pending/{kind}/{pending_id}/{decision}")
def decide_pending(kind: str, pending_id: str, decision: str, body: dict | None = Body(None)) -> dict:
    if decision not in DECISIONS:
        raise HTTPException(status_code=404, detail="unknown decision")
    _require_kind(kind, allow_all=False)
    _require_id(pending_id)
    if not _decisions_enabled():
        # Hermes counts 5xx responses as dashboard faults.
        raise HTTPException(status_code=403, detail="approve/reject are disabled for this profile")
    expect = (body or {}).get("expect")
    if not isinstance(expect, dict):
        raise HTTPException(status_code=400, detail="Preview this write first and send its expect value.")
    with _adapter_errors():
        outcome = ADAPTER.decide(kind, pending_id, decision, expect)
    if isinstance(outcome, Mapping) and outcome.get("status") in ("applied", "rejected", "needs_review"):
        _emit_pending_changed(kind, outcome.get("status", ""))
    return outcome


def _emit_pending_changed(kind: str, status: str) -> None:
    """A ``needs_review`` reply can repeat an earlier marker, prompting an extra read.

    A separate plugin host cannot reach gateway windows, which fall back to polling.
    Never include proposal text, IDs, or expect tokens: every gateway window gets this event.
    """
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event
    except ImportError:
        return
    try:
        broadcast_plugin_event(PLUGIN_ID, PENDING_CHANGED_EVENT, {"kind": kind, "status": status})
    except Exception:
        return
