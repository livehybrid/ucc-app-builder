# Task: oauth-client-credentials

Build a Splunk UCC add-on configured for OAuth 2.0 client credentials and a
single modular input that uses the account.

Requirements:

- App id: `TA_oauth_client_demo`
- `globalConfig.json` must include:
  - Account/auth configuration for OAuth client credentials
  - Fields for `client_id`, `client_secret`, `token_url`, `scope`
  - A modular input service `oauth_events_input` with account selector
- Generate:
  - `package/default/oauth.conf`
  - `package/bin/oauth_events_input.py`
  - helper module for token retrieval + event pull
- Ensure `client_secret` is treated as encrypted/password field.
- Input script should demonstrate token acquisition + API call flow using helper
  methods and clear error logging.

The agent passes when:

- `ucc-gen build` succeeds.
- AppInspect has no failures.
- OAuth-related config files are present and consistent with globalConfig.
