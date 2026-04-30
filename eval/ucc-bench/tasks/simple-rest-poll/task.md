# Task: simple-rest-poll

Build a Splunk UCC add-on that polls the JSONPlaceholder posts endpoint
(`https://jsonplaceholder.typicode.com/posts`) every 60 seconds and writes each
post as a Splunk event.

Requirements:

- App id: `TA_jsonplaceholder_demo`
- One input type called `posts_input` with a single `endpoint` field
  (string, default `https://jsonplaceholder.typicode.com/posts`).
- One Python modular input at `package/bin/posts_input.py` that:
  - Uses the UCC SDK base class.
  - Fetches the endpoint.
  - Emits each JSON object as a separate event.
- `globalConfig.json` with version `1.0.0`, correct `restRoot`, a single input
  type definition, and no pages beyond `inputs` and `configuration`.
- No hard-coded secrets; the endpoint must be editable from the configuration
  page.

The agent passes when:

- `ucc-gen build` succeeds.
- AppInspect reports no failures (warnings are OK for v0).
- The modular input script imports and compiles under Python 3.9.
