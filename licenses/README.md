# licenses/

Auto-generated third-party license inventory for UCC App Builder.

**Do not edit by hand** — regenerate with:

```bash
# npm side is hermetic; for the Python advisor stack, build the app first:
bash splunk-app/deploy/build_agent_app.sh /tmp/uccbuild
python scripts/generate_licenses.py --python-lib /tmp/uccbuild/ucc_app_builder/lib
```

- `THIRD_PARTY_LICENSES.md` — human-readable summary + tables
- `manifest.json` — machine-readable inventory (incl. `is_oss` flag)
- `npm/`, `python/` — full license text, one file per package

CI regenerates this and runs `--check`, which fails the build if any bundled library is not a recognised open-source license.
