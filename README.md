# lesson-review

With `write_approval` turned on, Hermes doesn't write memory or skill changes straight away. It stages
them as pending writes and waits for you. This plugin adds a pane to Hermes Desktop that lists those
pending writes. Click one to open the review dialog, which shows the exact proposal with a diff for
each operation, then approve or reject it.

The list shows metadata only. Full content appears only in the review dialog.

## Requirements

- Hermes Agent with the `tools.write_review_api` service
  ([PR #158550](https://github.com/NousResearch/hermes-agent/pull/158550)). On an older build the pane
  says the service is unavailable.
- Hermes Desktop, or the Webapp.
- `memory.write_approval` or `skills.write_approval` set to `true` in the profile's config.
  Otherwise nothing gets staged and the pane stays empty.

## Install

```bash
hermes plugins install weeix/hermes-lesson-review --enable
hermes gateway restart        # or restart the headless backend
```

Then open Desktop, go to Capabilities > Plugins and turn on `lesson-review`. The desktop half is
opt-in, so the pane won't show up until you do.

For development, link a checkout instead:

```bash
ln -s "$(pwd)" "$HERMES_HOME/plugins/lesson-review"
hermes plugins enable lesson-review
hermes gateway restart
```

Desktop (or the Webapp's host) copies the desktop half into
`$HERMES_HOME/desktop-plugins/lesson-review/`. You still turn it on in Capabilities > Plugins.

## Config

Approve and Reject are on by default. To make the dialog read-only for a profile, set
`allow_decisions` to `false`, either with `hermes plugins config lesson-review` or in Desktop
Settings > Plugins. It ends up in the profile's `config.yaml`:

```yaml
plugins:
  entries:
    lesson-review:
      settings:
        allow_decisions: false
```

A few details:

- If `settings` has no `allow_decisions`, the older `plugins.entries.lesson-review.config.allow_decisions`
  is used instead.
- Only a boolean `true`, or no value at all, allows decisions. Anything else turns them off, and so
  does a config file Hermes can't read.
- Setting `LESSON_REVIEW_ALLOW_DECISIONS=0` (or `false`, `no`, `off`) on the Hermes backend turns
  decisions off for every profile. No environment variable can turn them on.
- This setting is separate from `write_approval`. Turning `write_approval` off doesn't throw away
  writes that are already pending.

## Disclosure

For catalog reviewers:

- It registers no agent tools, hooks or middleware. `register()` in `__init__.py` is empty.
- It reads and decides pending writes only through the public `tools.write_review_api` service
  (`list_writes`, `preview_write`, `decide_write`). It never opens the pending queue files itself.
  Approve and Reject go through Hermes' own resolver, which does the actual write.
- It makes no external network calls. The desktop half only talks to this plugin's own routes
  through the plugin SDK.
- It holds no credentials.
- Hermes checks the session token before any of the plugin's routes run, and each request sees only
  the profile it is scoped to. Unauthenticated requests get a 401 (covered by
  `tests/test_mounted.py`).

## API

`LESSON_REVIEW_ADAPTER=core` (the default) uses the core service for the request's profile.
`LESSON_REVIEW_ADAPTER=fake` serves fixture records for development and can't approve or reject.

`POST /pending/{kind}/{id}/{approve|reject}` takes `{"expect": <the preview's expect value, unchanged>}`
and returns the resolver's outcome. Check the outcome: an HTTP 200 alone doesn't mean the write was
applied.

A malformed `kind` or `pending_id` gets a 400 before core is called. If core refuses the profile's
pending store, you get a 409, not an empty list.

## Names on the Desktop Plugins page

Desktop puts the `plugin.yaml` `name` on the server card and the desktop half's own `name` on the
desktop card. When the two halves pair, the joined card uses the desktop name. Pairing needs the
`.hermes-package.json` marker that the install dialog or the reconcile pass writes. If you copy
`plugin.js` by hand, there's no marker and it shows up as a separate card.

This plugin uses `lesson-review` everywhere: `plugin.yaml`, `dashboard/manifest.json` and
`desktop/plugin.js`. `tests/test_manifest.py` and `tests/render/run.mjs` check that the names match.
The pane heading says "Lesson review", but the items are still called "pending writes" (badge, empty
state, dialog title). The server half has no display label the Plugins page reads. A `label` in
`plugin.yaml` is accepted but ignored, and the dashboard `label` only shows for dashboard plugins
with no agent row.

## Running the checks

```bash
uv venv --python 3.14 .venv && uv pip install --python .venv/bin/python pytest fastapi httpx
env -u PYTHONPATH .venv/bin/python -m pytest -q    # mounted tests skip without HERMES_SRC
env -u PYTHONPATH HERMES_SRC=/path/to/hermes-agent HERMES_PYTHON=/path/to/hermes/python \
    .venv/bin/python -m pytest -q

hermes plugins validate .

# render smoke test (needs node; no server)
(cd tests/render && npm install)
.venv/bin/python tests/render/make-snapshot.py      # plugin routes over fixture records
(cd tests/render && WR_SNAPSHOT=.generated/snapshot.json node run.mjs)
(cd tests/render && node interact.mjs)              # dialog interactions: jsdom + the host's react-query
(cd tests/render && node focus.mjs)                 # focus on open/close: jsdom + the host's Radix dialog

# or against a live backend with a staged skills batch and a memory record
(cd tests/render && WR_TOKEN=... WR_BASE=http://127.0.0.1:9431 node run.mjs)
```

`HERMES_PYTHON` has to be an interpreter that can import Hermes' dependencies (FastAPI, httpx,
PyYAML). The mounted tests only write under pytest's temp dir. Each scenario points `HOME` and
`HERMES_HOME` at a throwaway tree, so your real `~/.hermes` is never touched.

## Known limits

- Proposals are shown in full, and memory content is user data. Anyone who can authenticate to the
  Hermes backend can pick a profile with `?profile=` and read its pending writes, as long as that
  profile has the plugin enabled.
- The needs-review banner hasn't been seen in a native Desktop run yet.
- Profile switching hasn't been tried in a real Desktop. Server-side profile scoping is covered by
  `tests/test_mounted.py`.
