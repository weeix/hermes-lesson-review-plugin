# lesson-review

Lesson review is a review pane for pending writes: the memory and skill changes Hermes stages
when `write_approval` is on. Lists use
metadata only; the review dialog shows the exact proposal and per-op diffs. The
plugin uses the public core list/preview/decide service and does not read queue files in production.
Older Hermes builds without that service show an unavailable state.

**Approve and Reject are on by default.** Each profile can make the dialog read-only with the
`allow_decisions` setting (`hermes plugins config lesson-review`, or Desktop Settings → Plugins), stored
at `plugins.entries.lesson-review.settings.allow_decisions`; the legacy
`plugins.entries.lesson-review.config.allow_decisions` is read when `settings` has no value. Only a
boolean `true` (or no value) allows decisions, and a config Hermes cannot read turns them off.
`LESSON_REVIEW_ALLOW_DECISIONS=0` (or `false`, `no`, `off`) on the Hermes backend turns them off for
every profile; no environment variable turns them on. The setting is separate from each subsystem's
staging flag, and turning a staging flag off does not discard pending proposals.

## Layout (unified package: agent half + desktop half + backend)

```
plugin.yaml                  manifest (no tools or hooks); name = the package name
__init__.py                  no-op register(ctx); lets plugin doctor/validate run the registration probe
dashboard/manifest.json      backend mount: api = plugin_api.py  ->  /api/plugins/lesson-review/
dashboard/plugin_api.py      FastAPI router: GET list/preview, POST a gated per-record decision
dashboard/adapter.py         CoreAdapter over core's review API; FakeAdapter is the same over fixture replies
desktop/plugin.js            desktop half: pane (placement right), review dialog per pending write, status-bar badge (no JSX, no build)
tests/test_adapter.py        CoreAdapter's reshaping and error mapping, run over the fixtures (no Hermes needed)
tests/test_routes.py         route tests on a bare router: validation, status codes, the decision gate
tests/test_mounted.py        mounted tests through Hermes' web app (HERMES_SRC + HERMES_PYTHON)
tests/mounted_probe.py       the probe test_mounted.py runs in a Hermes interpreter (one process per scenario)
tests/test_manifest.py       naming contract: plugin.yaml, dashboard manifest and desktop half agree
tests/render/run.mjs         render smoke test: real React, stubbed SDK, live backend or snapshot
tests/render/interact.mjs    review dialog in jsdom with the host's react-query: refused decisions, Preview again
tests/render/focus.mjs       pane and dialog in jsdom with the host's Radix dialog: focus, dismissal, switches, polls
tests/render/make-snapshot.py  writes the snapshot run.mjs reads (the plugin's own routes over the fixtures)
tests/render/sdk-stub.mjs    static stand-in for @hermes/plugin-sdk (test only); sdk-live/sdk-radix swap in real parts
tests/render/react-shim.mjs  static stand-in for react: useState reads a preselection from globalThis
tests/render/harness.mjs     shared by the three: generated plugin copy, jsdom setup, PASS/FAIL printer, fixtures
```

### Adapter interface

```
list_pending(kind: "all"|"memory"|"skills", page: int) -> {counts, total, gates, needs_review, items[]}
get_preview(kind, pending_id) -> record | None      (per-op fields and diffs)
decide(kind, pending_id, decision, expect) -> outcome   (the routes allow it for the core adapter only)
```

`LESSON_REVIEW_ADAPTER=core` (default) uses the core service in the request's authorized profile.
`LESSON_REVIEW_ADAPTER=fake` serves eight fixture records (memory add/replace/remove, a memory
batch, skill create/patch/delete, a three-op skill batch) for development.

The production adapter imports `tools.write_review_api` symbols registered in the core public
plugin API. `POST /pending/{kind}/{id}/{approve|reject}` takes `{"expect": <unchanged preview value>}`
and returns a semantic resolver outcome. HTTP 200 alone does not mean an approval applied.
The host owns authentication, request scope, and the browser origin check.

### Store rules (enforced by core)

Core owns the pending store: minted ids only (`[0-9a-f]{8}`), no links at `pending/` or
`pending/<kind>`, regular files only. A store core refuses is a 409, not an empty queue
(`test_mounted.py` plants a link). Routes validate `kind` and `pending_id` before calling the
adapter: bad input is 400.

## Error states in the pane and the badge

A failed read shows nothing from an earlier read (react-query keeps the last good data on error).
The status comes from the error's `statusCode`, or from its message: in native Desktop, Electron's IPC
passes only the message, wrapped as `Error invoking remote method 'hermes:api': Error: 409: …`.
A 4xx answer is final and shows at once; a 5xx or a network error is retried once (Desktop's query
client would otherwise retry three times, 1, 2 and 4 s apart, showing "Loading…" meanwhile).
After a decision, every cached list page of the profile is refreshed, the badge's included.

| What failed | Pane | Badge (title) |
|---|---|---|
| 404 `Plugin not found` (plugin off on this Hermes) | Lesson review is turned off on this Hermes. Turn it on in Capabilities → Plugins. | `pending writes: –` (same text) |
| other 404 | Lesson review is not available on this Hermes (HTTP 404). | `pending writes: –` |
| network error, or 5xx | Could not reach Hermes. | `pending writes: –` (same text) |
| 409 (core refused the store) | Hermes could not access this profile’s pending store. | `pending writes: –` (same text) |
| 503 (no Write Review API in this Hermes) | Update Hermes to use Lesson review. | `pending writes: –` (same text) |
| 401 / 403 | Hermes refused this session (HTTP …). Reconnect, then Retry. | `pending writes: –` (same text) |

Retry stays. The raw error text is only in a tooltip. An empty queue is still
"No pending writes in this profile.", with zero counts. A record that is gone shows
"That record is no longer pending."

## Pages

Core returns 25 writes per page, and `total` counts all of them. When there are more, the pane shows
the range ("26–30 of 30") with Previous and Next under the list. A filter change starts again at page
1. If a decision empties the last page, the pane moves to the page that is now last. The badge counts
every pending write.

## Review dialog

Selecting a row opens a review dialog for that record (the SDK `Dialog`); the pane keeps the list.
The dialog holds the proposal and per-op diffs. Diff lines use Desktop's own diff colours
(`--ui-diff-add-*` / `--ui-diff-remove-*`, which follow the theme), with headers muted; the `+`/`-`
prefix stays. Approve and Reject sit in a footer under the scrolling
body. A decision's outcome:

- `applied`: the dialog closes; a success toast names the store (memory or skills).
- `rejected`, `already_resolved`: the dialog closes; an info toast. Toasts use fixed wording only, never
  the record, id, reason or expect value.
- `needs_review`: the dialog stays open with a "Needs review" notice that gives the reason; Approve and
  Reject are disabled; Close remains.
- `conflict`, or a failed request: the dialog stays open with the reason ("Not decided" for a failure).
  Approve and Reject stay disabled until "Preview again" has loaded the record again: while it loads, the
  old preview stays on screen but cannot be decided on. If that load fails, nothing can be decided and
  Preview again stays offered.
- 501 (the profile turned decisions off after the preview loaded): the dialog stays open and says
  decisions are turned off for this profile; Preview again loads the read-only preview.

Opening the dialog focuses the dialog itself, not Approve. Closing it returns keyboard focus to the row that
opened it; after a decision removed that row, to the row now in its place (or the pane). While a decision
is in flight, Esc, the X and an outside click do nothing. A reply that arrives after a
profile or gateway switch is dropped (no toast, no close). Every decision refreshes the list. A failed
list poll does not close an open dialog.

## Needs review banner

Core's list reply has `needs_review`: a count per kind plus `total` for writes whose approval stopped
partway. They are not in the list or its counts, and nothing in the plugin can approve or close them.
When the total is above zero, the pane shows a warning banner above the filters with the count, the
per-kind split and what to do: check the files by hand, then close each write with
`/memory reject <id>` or `/skills reject <id>` (only the kinds that have one are named;
`/memory pending` or `/skills pending` shows the ids). The banner has no buttons. It covers both kinds
under every filter, as core does. A zero count or a failed read shows no banner. The status-bar
badge counts only pending writes.

## Names (Desktop Plugins page)

Desktop shows the agent row's manifest name (`plugin.yaml` `name`) on the server card. A desktop
half shows its own `name` on the desktop card, and on the joined card when the two pair. Pairing
needs the desktop copy's `.hermes-package.json` marker (written by the install dialog or the
reconcile pass). A hand-copied `plugin.js` has no marker and stays a separate card.

This plugin uses one name, `lesson-review`, in `plugin.yaml`, `dashboard/manifest.json` and
`desktop/plugin.js`. The pane heading reads "Lesson review"; the staged items themselves are still
"pending writes" (badge, empty state, dialog title). `tests/test_manifest.py` checks
the three names agree. The server half has no display label that the Plugins page reads: `plugin.yaml`
`label` is accepted and unused, and dashboard `label` only shows for dashboard plugins that have no
agent row.

## Install into a Hermes home (development)

```bash
ln -s "$(pwd)" "$HERMES_HOME/plugins/lesson-review"    # unified package, linked checkout
hermes plugins enable lesson-review                    # plugins.enabled: [lesson-review]
hermes gateway restart                                 # or restart the headless backend
```

The desktop half is copied to `$HERMES_HOME/desktop-plugins/lesson-review/` by the reconcile pass
(Desktop, or the Webapp's host). It is opt-in (`defaultEnabled: false`): turn it on in
Capabilities > Plugins.

## Running the checks

```bash
uv venv --python 3.14 .venv && uv pip install --python .venv/bin/python pytest fastapi httpx
.venv/bin/python -m pytest -q                          # mounted tests skip without HERMES_SRC
HERMES_SRC=/path/to/hermes-agent HERMES_PYTHON=/path/to/hermes/python .venv/bin/python -m pytest -q

hermes plugins validate .                              # from a Hermes checkout/venv

# render smoke test (needs node + react; no server):
(cd tests/render && npm install)
.venv/bin/python tests/render/make-snapshot.py                    # plugin routes, fixture records

(cd tests/render && WR_SNAPSHOT=.generated/snapshot.json node run.mjs)
(cd tests/render && node interact.mjs)                             # dialog interactions: jsdom + the host's react-query
(cd tests/render && node focus.mjs)                                # focus on open/close: jsdom + the host's Radix dialog
# or against a live backend (needs a staged skills batch and a memory record):
(cd tests/render && WR_TOKEN=... WR_BASE=http://127.0.0.1:9431 node run.mjs)
```

`HERMES_PYTHON` must be an interpreter that imports Hermes' dependencies (FastAPI, httpx, PyYAML).
The mounted tests write only under pytest's temp dir: each scenario pins `HOME` and `HERMES_HOME`
to a throwaway tree, and the real `~/.hermes` is never used.

## Known limits

- The decision route returns 501 (`approve/reject are disabled for this profile`) for the fake adapter, a
  profile with `allow_decisions: false`, or the environment override; the dialog then says decisions are
  turned off for this profile. Decisions go through the core resolver; the plugin never writes to the
  pending store itself.
- Records are shown in full. Memory content is user data; the pane shows it to anyone the Hermes
  backend admits.
- A usable Approve uses the primary (`default`) button variant; Reject, and any disabled decision button,
  use the neutral variant, dimmed with inline styling when disabled. The dialog's width and
  height and the notice colours are inline too. The Desktop acceptance run at `608d81f` covered the
  dialog; the needs-review banner has not been seen in a native run yet. In jsdom, Radix lands focus on
  the dialog even without the plugin's open-focus handler, so the tests can't show that Enter on open
  doesn't approve.
- Profile switching is handled by the SDK (`ctx.rest` carries the profile; the query key includes
  it). The profile scoping on the server is covered by `test_mounted.py`; not exercised in a real
  Desktop.
