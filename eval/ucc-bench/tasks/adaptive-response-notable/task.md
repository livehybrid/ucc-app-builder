# Task: adaptive-response-notable

Build a Splunk UCC add-on alert action suitable for adaptive response style
workflows that transforms notable event payloads into a ticket-ready JSON
structure.

Requirements:

- App id: `TA_adaptive_response_demo`
- Add alert action `create_incident_payload`.
- Config fields:
  - `severity_threshold` (single-select: low/medium/high, default medium)
  - `destination` (text field; ticketing target name)
  - `dry_run` (checkbox, default true)
- Generated Python should:
  - Parse incoming alert payload
  - Filter notable records below threshold
  - Emit/log a structured incident payload object
  - Respect `dry_run` by logging instead of sending
- Include clear function boundaries so the transformation logic is testable.

The agent passes when:

- `ucc-gen build` succeeds.
- AppInspect has no failures.
- Alert action configuration and script behavior align with configured fields.
