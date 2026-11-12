# Changelog

All notable changes to this project are documented here. The format follows a
simple version-per-release list; this project is pre-1.0 and versioned by
capability, not by compatibility guarantees.

## 0.2.0

Session-backed delegations.

- Every delegation now creates a real DSH child session: a one-shot catalog row
  in the parent, a `subagent/descriptor` v3, and a read-only transcript the
  official Subagent UI can open.
- Pi's `--mode json` event stream is projected live while the run is active:
  reasoning, visible text, tool calls with their arguments, tool results with
  error state, per-step token usage, and a real `turn/end`. Timestamps are the
  real run times, so the UI reports a true duration.
- One Pi turn maps to one DSH step, so multi-call runs read as a single turn
  with several steps.
- Delegation can be continued: pass the returned `session` id to reuse the same
  DSH child session and the same stored Pi conversation. Reuse appends a new
  turn; it does not add another descriptor or catalog row. Continuation works
  within one DSH host process.
- `logMode: "summary"` (default) writes a few-KB log per run instead of teeing
  the whole JSON stream; `logMode: "full"` keeps the previous behavior.
- `scripts/cleanup.mjs` prunes old logs by age (with `--dry-run` and a
  report-only `--sessions` mode for stored sessions).
- `bin/pi-dev` gained `--mode`, `--session-id`, and `--session-dir`.
- Read-only limitations are documented: one-shot children have no in-UI Stop,
  and cold sessions cannot be continued after a host restart.

## 0.1.0

Initial release.

- Pi exposed as an out-of-process DSH subagent backend through `pi-dev`.
- Bundled portable `bin/pi-dev` wrapper with a throwaway Pi state directory,
  credential handoff, fixed rules, a pinned model, and a delegation record.
- Bundle manifest, locale metadata, unit tests, and CI.
