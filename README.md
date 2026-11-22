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

## Adapter

`LESSON_REVIEW_ADAPTER=core` (default) uses the core service in the request's authorized profile.
`LESSON_REVIEW_ADAPTER=fake` serves fixture records for development.

The production adapter imports `tools.write_review_api` symbols registered in the core public
plugin API. `POST /pending/{kind}/{id}/{approve|reject}` takes `{"expect": <unchanged preview value>}`
and returns a semantic resolver outcome. HTTP 200 alone does not mean an approval applied.

Routes refuse a malformed `kind` or `pending_id` with 400 before calling core. A pending store core
refuses is a 409, not an empty queue.

## Names (Desktop Plugins page)

Desktop shows the agent row's manifest name (`plugin.yaml` `name`) on the server card. A desktop
half shows its own `name` on the desktop card, and on the joined card when the two pair. Pairing
needs the desktop copy's `.hermes-package.json` marker (written by the install dialog or the
reconcile pass). A hand-copied `plugin.js` has no marker and stays a separate card.

This plugin uses one name, `lesson-review`, in `plugin.yaml`, `dashboard/manifest.json` and
`desktop/plugin.js`. The pane heading reads "Lesson review"; the staged items themselves are still
"pending writes" (badge, empty state, dialog title). `tests/test_manifest.py` and
`tests/render/run.mjs` check the three names agree. The server half has no display label that the
Plugins page reads: `plugin.yaml` `label` is accepted and unused, and dashboard `label` only shows for
dashboard plugins that have no agent row.

## Install into a Hermes home (development)

```bash
ln -s "$(pwd)" "$HERMES_HOME/plugins/lesson-review"    # unified package, linked checkout
hermes plugins enable lesson-review                    # plugins.enabled: [lesson-review]
hermes gateway restart                                 # or restart the headless backend
```

The desktop half is copied to `$HERMES_HOME/desktop-plugins/lesson-review/` by the reconcile pass
(Desktop, or the Webapp's host). It is opt-in: turn it on in Capabilities > Plugins.

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

- Decisions go through the core resolver; the plugin never writes to the pending store itself.
- Records are shown in full. Memory content is user data; the pane shows it to anyone the Hermes
  backend admits.
- The needs-review banner has not been seen in a native Desktop run yet.
- Profile switching has not been exercised in a real Desktop. The profile scoping on the server is
  covered by `test_mounted.py`.
