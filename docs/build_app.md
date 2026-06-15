# Building add-ons - the build & validate loop

This page explains what happens when the builder **builds** your add-on: what `ucc-gen`
regenerates, what you (or the agent) actually author, and how the self-correcting
AppInspect loop reaches a clean package. It is the conceptual companion to the
[Architecture](architecture_diagram.md) and the hands-on [User Guide](USER-GUIDE.md).

## The correct UCC source model

The single most common beginner mistake is editing a file that `ucc-gen` **regenerates** on
every build, then wondering why the change keeps disappearing. The builder is opinionated
about this so you never go in circles.

**`globalConfig.json` is the core artifact**, authored at the project **root**. From it,
plus a small set of hand-authored files, `ucc-gen` generates everything else.

You (or the agent) author **only**:

| You author | Where | Notes |
|---|---|---|
| `globalConfig.json` | project **root** | inputs, configuration tabs, UI, alerts |
| `package/app.manifest` | `package/` | **REQUIRED** - `ucc-gen` does *not* generate it. If omitted, the build's deterministic manifest guard generates a valid one from globalConfig metadata so the build never fails for a missing manifest. |
| `package/bin/*.py` | `package/bin/` | your modular-input collection logic |
| `package/lib/requirements.txt` | `package/lib/` | python deps (pinned for AppInspect-clean packaging - see below) |
| `package/static/` icons | `package/static/` | app icons only (no non-image files) |

`ucc-gen` **generates** (do **not** hand-edit - silently overwritten next build):

- `default/*.conf` including `app.conf` and `inputs.conf`
- the modular-input wrappers and the bundled UCC lib
- the Configuration / Inputs UI from `globalConfig.json`

So the authoring order the agent (and you) should follow is:

> author `globalConfig.json` → provide `package/app.manifest` → **build** (let ucc-gen
> generate the boilerplate) → **then** implement the collection logic in `package/bin/`.

## What "build" runs

A build is two Splunk developer tools in sequence:

1. **`ucc-gen build` + `ucc-gen package`** - scaffolds the add-on from `globalConfig.json`
   and packages it to a `.tar.gz`.
2. **`splunk-appinspect inspect`** - runs Splunk's certification checks and returns a
   structured report.

**Where it runs depends on the face:**

- **Native Splunk app** - entirely in **Splunk's own python**, via `bin/builder_build.py`,
  with `ucc-gen` and `splunk-appinspect` **vendored into `lib/`**. There is **no Node
  sidecar**. (The native lib is built at deploy time by
  `splunk-app/deploy/build_agent_app.sh`, which installs the latest ucc-framework +
  appinspect - currently 6.5.x / 4.2.x.)
- **Standalone web app** - the equivalent loop in Node (`server/services/agentLoop.ts`),
  using `ucc-gen`/`splunk-appinspect` on your `PATH`.

## The clean gate - what blocks, what is advisory

AppInspect groups its results into `error`, `failure`, `future_failure`, `warning`,
`success`, `skipped`, `not_applicable`. The builder's **clean determination is
failures + errors only**:

```
clean = (failure + error) == 0
```

- **`failure` / `error`** → **block** packaging. These are what the self-correcting loop
  fixes.
- **`warning`** → **advisory**. Surfaced to you, but does not block.
- **`future_failure`** → **advisory**. A check that passes today but will fail at a future
  Splunk release. Surfaced so you can fix it ahead of time, but it does **not** fail the
  build.

> Note: an AppInspect `future_failure`'s *per-check* `result` field is literally
> `"failure"` (it is categorised as "future" only by date). The builder therefore decides
> clean/blocked from AppInspect's **summary counts**, not from per-check results - so a
> future-dated check can never wrongly block a clean build.

When a build is clean with advisories, the build-loop reports, e.g.:

> No AppInspect failures or errors - build is clean. Advisory only (does not block
> packaging): 2 future-failure(s) and 14 warning(s) - review before a future Splunk release.

## The self-correcting loop

```
generate (ucc-gen build + package)
   → splunk-appinspect (inspect)
   → parse actionable checks
   → fix:  deterministic rules first (free), then the LLM fixer for the rest
   → rebuild from corrected source
   → repeat until clean (or maxIterations)
```

The fixers are grounded in real `ucc-gen` semantics, e.g.:

- `check_for_updates_disabled` → set `meta.checkForUpdates = false` in **`globalConfig.json`**
  (editing the generated `app.conf` is overwritten next build).
- missing `pages.inputs.table` → synthesise it from the service's entities.
- missing `package/app.manifest` → generate it from globalConfig metadata.
- `check_aarch64_compatibility` → pin `solnlib < 8` (see dependency pins below).

A **no-progress breaker** stops the loop the moment a fix changes nothing AND the build
fails again with the identical error - so it never grinds to the iteration cap (or burns
LLM spend) going in circles. Every step is traced and rendered inline in the chat.

In the native app the iteration cap is configurable in the AI Assistant's **Settings**
(**1-100, default 30**); the standalone Node server clamps to **1-20, default 12**.

## Why the dependency pins (AppInspect-clean packaging)

The generator emits `solnlib>=5.0.0,<8` (and `splunktaucclib>=6.6.0,<9`) into
`package/lib/requirements.txt`. `solnlib` 8.0.0 pulls in `grpcio`/`opentelemetry`, which
bundle **AArch64-incompatible native binaries** that fail AppInspect
`check_aarch64_compatibility`. `solnlib` 7.x is pure-python and keeps the package clean.
The generator also maps a `password` field to a UCC `text` entity with `encrypted: true`
(UCC has no `password` entity type), never ships `metadata/local.meta`, and avoids
non-image files under `static/`.

## Triggering a build

- **In the app** - the AI Assistant calls `build_and_inspect` itself during a chat; the
  standalone **AppInspect Loop** panel runs the same loop deterministically (no LLM) for a
  reproducible demo.
- **Over HTTP (SSE)** - `POST /api/agent/build-loop` streams `start, build, inspect, fix,
  clean/exhausted, done, result` events.
- **One-shot build** - `POST /api/build` returns a build id; `GET /api/build/<id>` polls
  status and `GET /api/build/<id>/download` returns the packaged `.tar.gz`.

See the [User Guide](USER-GUIDE.md) for the click-by-click version and the
[Architecture](architecture_diagram.md) for how the pieces fit together.
