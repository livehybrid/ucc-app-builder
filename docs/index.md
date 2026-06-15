# UCC App Builder

**An *agentic* Splunk add-on builder** — describe an add-on in chat and a tool-calling AI
agent edits the source, grounds the design in your live Splunk, then **builds → runs
`splunk-appinspect` → self-corrects → repeats until the package is App-Inspect-clean**.
It ships **both** as a standalone web IDE and as a **native Splunk app** (`ucc_app_builder`),
and exposes its actions as **Splunk MCP Server tools** any external agent can call.

> Splunk Agentic Ops Hackathon 2026 · Platform & Developer Experience track

## Start here

- **[User Guide](USER-GUIDE.md)** — a click-by-click tour: the AI Assistant, the Monaco
  editor's autocomplete + AI tab-completion, and GitHub import/export.
- **[Project README](https://github.com/livehybrid/ucc-app-builder#readme)** — the full
  feature tour, setup and run instructions, and the live-on-Splunk proof.
- **[Architecture](architecture_diagram.md)** — how the standalone app, the native Splunk
  app and the shared build engine fit together.
- **[Building add-ons](build_app.md)** — the build/validate loop and what `ucc-gen`
  regenerates on every build.
- **[splunklib.ai notes](SPLUNKLIB.md)** — the Splunk Agent SDK integration and the
  in-Splunk gotchas.
- **[UCC reference](UCC-DOCS.md)** — globalConfig schema and UCC conventions the builder
  tracks.

## The agentic loop

1. **Describe** the add-on in chat (or walk the wizard).
2. The agent **expands** the request into a reviewable UCC spec, then authors
   `globalConfig.json` and the Python with its file tools.
3. It **builds with `ucc-gen`**, runs **`splunk-appinspect`**, reads the findings, and
   **self-corrects** — surfacing the whole trace inline — until the package is clean.

## The authoring & data toolkit

- **Test Input** — emulate a modular input's `stream_events` (real HTTP, no install) and
  see the actual events it would index.
- **Generate dashboards / saved searches / tests** — deterministic emitters for Dashboard
  Studio v2 views, `savedsearches.conf`, and a **pytest-splunk-addon** CIM/field-validation
  suite. Closes the data loop: *Test Input → author props/transforms → generate_tests*.
- **My Apps** — a server-side library of saved add-on projects (save / resume across
  sessions and devices).
- **Seed from an installed add-on** — load an add-on already installed on this Splunk into
  the builder to extend it with the AI.
- **Run History** — replay any past Splunk Agent SDK run's full trace; **Stop** cancels the
  run server-side.

See the [README](https://github.com/livehybrid/ucc-app-builder#readme) for the complete,
up-to-date list.
