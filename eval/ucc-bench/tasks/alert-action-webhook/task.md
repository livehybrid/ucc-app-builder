# Task: alert-action-webhook

Build a Splunk UCC add-on with a custom alert action that sends a JSON payload
to an external webhook endpoint.

Requirements:

- App id: `TA_alert_webhook_demo`
- Add one alert action called `send_webhook`.
- The alert action setup page must include:
  - `webhook_url` (required URL/string field)
  - `auth_token` (optional password/encrypted field)
- Generate the required files:
  - `package/default/alert_actions.conf`
  - `package/bin/send_webhook.py`
  - helper module used by the main script
- Python logic should:
  - Parse alert payload from stdin
  - Build a JSON body containing search results + metadata
  - POST to the configured webhook URL
  - Log failures with clear error messages
- Do not hard-code endpoint URLs or tokens in code.

The agent passes when:

- `ucc-gen build` succeeds.
- AppInspect has no failures.
- `alert_actions.conf` stanza matches generated Python entrypoint.
