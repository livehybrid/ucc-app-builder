"""
globalConfig.json pre-validation against the REAL ucc-framework JSON Schema.

Why this exists
---------------
`ucc-gen build` validates globalConfig.json with `jsonschema.validate(...)` and then
raises only `e.message` - the string chosen by jsonschema's `best_match()`. For the
`InputsPage` node (a `oneOf` of "single page-level table" vs "table per service") that
message is actively misleading: an unknown property such as `subTitle` makes BOTH
branches fail, and `best_match` reports the *other* branch's complaint - e.g.

    'table' is a required property

...or, once the model dutifully adds a table:

    {...whole service object...} should not be valid under {'required': ['table']}

The word `subTitle` never appears, so an LLM oscillates between adding and removing the
table forever and burns its whole step budget. (Observed 2026-07-29.)

This module validates the SAME schema but reports every leaf error with its JSON path,
and - crucially - for an `additionalProperties` failure it lists the properties that ARE
allowed at that path. That turns the unactionable message above into:

    $.pages.inputs: unknown property 'subTitle'. Allowed here: description, services,
    subDescription, table, title.

Used by builder_build.build_and_inspect (fail fast before a ~15-minute ucc-gen run) and
exposed to the agent as the `validate_global_config` / `ucc_schema_help` tools.
"""
import json
import os
import sys

_BIN = os.path.dirname(os.path.abspath(__file__))
_APP_LIB = os.path.join(os.path.dirname(_BIN), "lib")

# Cap what we hand back: an LLM acts on the first few errors, and a full oneOf expansion
# of a large globalConfig can run to hundreds of leaves.
MAX_ERRORS = 12


def _ensure_lib_on_path():
    if os.path.isdir(_APP_LIB) and _APP_LIB not in sys.path:
        sys.path.insert(0, _APP_LIB)


def schema_path():
    """Locate the installed ucc-framework schema. Returns None when unavailable."""
    _ensure_lib_on_path()
    try:
        import splunk_add_on_ucc_framework as ucc
        root = os.path.dirname(os.path.abspath(ucc.__file__))
    except Exception:  # noqa: BLE001 - not installed / import error: skip validation
        root = os.path.join(_APP_LIB, "splunk_add_on_ucc_framework")
    p = os.path.join(root, "schema", "schema.json")
    return p if os.path.isfile(p) else None


_SCHEMA_CACHE = {}


def load_schema():
    """The authoritative globalConfig schema dict, or None when it can't be found."""
    p = schema_path()
    if not p:
        return None
    cached = _SCHEMA_CACHE.get(p)
    if cached is not None:
        return cached
    try:
        with open(p, "r", encoding="utf-8") as fh:
            schema = json.load(fh)
    except Exception:  # noqa: BLE001
        return None
    _SCHEMA_CACHE[p] = schema
    return schema


def ucc_version():
    _ensure_lib_on_path()
    try:
        import splunk_add_on_ucc_framework as ucc
        return getattr(ucc, "__version__", "") or ""
    except Exception:  # noqa: BLE001
        return ""


def _fmt_path(parts):
    """A jsonschema absolute_path deque -> a `$.pages.inputs.services[0]` style pointer."""
    out = "$"
    for p in parts:
        out += "[%d]" % p if isinstance(p, int) else ".%s" % p
    return out


def _allowed_props(subschema):
    """The property names a schema node accepts, following a single level of
    oneOf/anyOf/allOf so a branchy node still yields a useful list."""
    names = set((subschema.get("properties") or {}).keys())
    for key in ("oneOf", "anyOf", "allOf"):
        for branch in subschema.get(key) or []:
            if isinstance(branch, dict):
                names.update((branch.get("properties") or {}).keys())
    return sorted(names)


def _leaf_errors(error, depth=0):
    """Flatten a jsonschema ValidationError, descending into oneOf/anyOf `context`.

    jsonschema's own `best_match` picks ONE branch and discards the rest; we keep them
    all and label which branch each came from, because the real mistake is often only
    visible in the branch best_match threw away.
    """
    ctx = list(getattr(error, "context", None) or [])
    if not ctx or depth > 3:
        return [(error, ())]
    out = []
    for sub in ctx:
        branch = getattr(sub, "schema_path", None)
        idx = None
        if branch:
            for item in branch:
                if isinstance(item, int):
                    idx = item
                    break
        for leaf, trail in _leaf_errors(sub, depth + 1):
            out.append((leaf, ((error.validator, idx),) + trail))
    return out


def _describe(error, trail):
    """One actionable line for a leaf error."""
    where = _fmt_path(error.absolute_path)
    branch = ""
    if trail:
        crumbs = ["%s branch %s" % (v, (i + 1) if isinstance(i, int) else "?")
                  for v, i in trail]
        branch = " [in %s]" % " > ".join(crumbs)

    if error.validator == "additionalProperties":
        # The single most useful case, and the one ucc-gen's message hides. `message`
        # already names the offending key(s); append what IS accepted here.
        allowed = _allowed_props(error.schema or {})
        extra = (" Allowed here: %s." % ", ".join(allowed)) if allowed else ""
        return "%s: %s.%s%s" % (where, error.message.rstrip("."), extra, branch)

    if error.validator == "required":
        return "%s: %s.%s" % (where, error.message.rstrip("."), branch)

    if error.validator == "enum":
        allowed = error.validator_value or []
        return "%s: value must be one of %s.%s" % (where, ", ".join(map(str, allowed)), branch)

    # Long instance dumps ("{...400 chars...} should not be valid under ...") are noise.
    msg = error.message
    if len(msg) > 220:
        msg = msg[:200] + "..."
    return "%s: %s.%s" % (where, msg.rstrip("."), branch)


def _rank(error):
    """Order errors most-actionable first. An unknown/misspelled property is nearly always
    the true cause when a oneOf node fails; `required` complaints are usually its shrapnel."""
    order = {"additionalProperties": 0, "enum": 1, "type": 2, "required": 3}
    return (order.get(error.validator, 4), len(list(error.absolute_path)))


def _subprocess_python():
    """Splunk's own python 3.13 (the interpreter the vendored wheels are built for)."""
    cand = os.path.join(os.environ.get("SPLUNK_HOME", "/opt/splunk"), "bin", "python3")
    return cand if os.path.exists(cand) else sys.executable


def _validate_in_subprocess(config):
    """Run the validation in a PRISTINE interpreter.

    splunkd runs persistent REST handlers in a SHARED interpreter carrying dozens of other
    apps' libraries in sys.modules / on sys.path, so an in-process `import jsonschema` can
    resolve to another app's copy (or a partially-initialised one) and fail - observed live
    on 2026-07-29 as "jsonschema not importable", which silently disabled pre-validation.
    builder_build/advisor_runner already dodge this the same way: spawn
    $SPLUNK_HOME/bin/python3 with PYTHONPATH = OUR lib only. Returns None if the subprocess
    could not run at all, so the caller can fall back.
    """
    import subprocess
    code = ("import json,sys;"
            "sys.path.insert(0, sys.argv[1]);"
            "sys.path.insert(0, sys.argv[2]);"
            "import builder_schema as bs;"
            "print(json.dumps(bs.validate_global_config(json.load(sys.stdin), _in_proc=True)))")
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "PYTHONPATH": _APP_LIB + os.pathsep + _BIN,
        "PYTHONDONTWRITEBYTECODE": "1",
        "SPLUNK_HOME": os.environ.get("SPLUNK_HOME", "/opt/splunk"),
        # Splunk's python needs its own lib dir for the bundled libssl/libcrypto.
        "LD_LIBRARY_PATH": os.path.join(os.environ.get("SPLUNK_HOME", "/opt/splunk"), "lib"),
    }
    try:
        proc = subprocess.run(
            [_subprocess_python(), "-c", code, _APP_LIB, _BIN],
            input=json.dumps(config), capture_output=True, text=True, timeout=60, env=env)
    except Exception:  # noqa: BLE001 - no interpreter / spawn refused
        return None
    out = (proc.stdout or "").strip()
    line = next((ln for ln in reversed(out.splitlines()) if ln.strip().startswith("{")), "")
    if not line:
        return None
    try:
        return json.loads(line)
    except ValueError:
        return None


def validate_global_config(config, _in_proc=False):
    """Validate a globalConfig dict against the installed ucc-framework schema.

    Returns {"ok": bool, "errors": [str], "uccVersion": str, "checked": bool}.
    `checked` is False when validation could not run - callers must then fall through to
    the real ucc-gen run rather than reporting a false pass.

    Validation happens in a clean subprocess by default (see _validate_in_subprocess);
    `_in_proc=True` is the recursive call inside that subprocess.
    """
    schema = load_schema()
    if schema is None:
        return {"ok": True, "errors": [], "uccVersion": ucc_version(), "checked": False,
                "note": "ucc-framework schema not found; skipped pre-validation"}
    _ensure_lib_on_path()
    try:
        import jsonschema
    except Exception as e:  # noqa: BLE001
        if _in_proc:
            return {"ok": True, "errors": [], "uccVersion": ucc_version(), "checked": False,
                    "note": "jsonschema not importable: %s: %s" % (type(e).__name__, e)}
        sub = _validate_in_subprocess(config)
        if sub is not None:
            # Record WHY we went out-of-process, so a future regression is diagnosable
            # instead of looking like a mysteriously slow validation.
            sub["via"] = "subprocess (in-process import failed: %s: %s)" % (type(e).__name__, e)
            return sub
        return {"ok": True, "errors": [], "uccVersion": ucc_version(), "checked": False,
                "note": "jsonschema not importable (%s: %s) and the clean-interpreter "
                        "fallback could not run; skipped pre-validation"
                        % (type(e).__name__, e)}

    try:
        validator_cls = jsonschema.validators.validator_for(schema)
        validator = validator_cls(schema)
    except Exception as e:  # noqa: BLE001
        return {"ok": True, "errors": [], "uccVersion": ucc_version(), "checked": False,
                "note": "schema not usable: %s" % e}

    leaves = []
    for err in validator.iter_errors(config):
        leaves.extend(_leaf_errors(err))
    if not leaves:
        return {"ok": True, "errors": [], "uccVersion": ucc_version(), "checked": True}

    seen = set()
    lines = []
    for err, trail in sorted(leaves, key=lambda t: _rank(t[0])):
        line = _describe(err, trail)
        key = (_fmt_path(err.absolute_path), err.validator, err.message[:80])
        if key in seen:
            continue
        seen.add(key)
        lines.append(line)
        if len(lines) >= MAX_ERRORS:
            lines.append("... (further errors suppressed; fix these first)")
            break
    return {"ok": False, "errors": lines, "uccVersion": ucc_version(), "checked": True}


def validate_global_config_text(text):
    """Same, from raw JSON text (so a syntax error is reported as such, not as a crash)."""
    try:
        config = json.loads(text)
    except ValueError as e:
        return {"ok": False, "errors": ["globalConfig.json is not valid JSON: %s" % e],
                "uccVersion": ucc_version(), "checked": True}
    if not isinstance(config, dict):
        return {"ok": False, "errors": ["globalConfig.json must be a JSON object"],
                "uccVersion": ucc_version(), "checked": True}
    return validate_global_config(config)


def _resolve(schema, node, depth=0):
    """Expand a single `$ref` (recursively, bounded) so a returned fragment is readable."""
    if not isinstance(node, dict) or depth > 6:
        return node
    ref = node.get("$ref")
    if isinstance(ref, str) and ref.startswith("#/"):
        target = schema
        for part in ref[2:].split("/"):
            if isinstance(target, dict) and part in target:
                target = target[part]
            else:
                return node
        return _resolve(schema, target, depth + 1)
    return node


def schema_help(name=None):
    """Return one named schema definition (refs expanded one level), or the list of
    available definition names when `name` is missing/unknown.

    This is the agent's self-service route out of a `oneOf` dead end: ask for
    `InputsPage` and get the two branches spelled out instead of guessing from a
    best_match message.
    """
    schema = load_schema()
    if schema is None:
        return {"ok": False, "error": "ucc-framework schema not available in this install"}
    defs = schema.get("definitions") or schema.get("$defs") or {}
    names = sorted(defs.keys())
    if not name:
        return {"ok": True, "uccVersion": ucc_version(), "definitions": names}
    # Case-insensitive exact, then substring.
    match = next((n for n in names if n.lower() == str(name).lower()), None)
    if match is None:
        subs = [n for n in names if str(name).lower() in n.lower()]
        if len(subs) == 1:
            match = subs[0]
        else:
            return {"ok": False, "error": "unknown definition '%s'" % name,
                    "didYouMean": subs[:20], "definitions": names}
    node = defs[match]
    out = dict(node) if isinstance(node, dict) else node
    # Expand the immediate branches so oneOf/anyOf are legible without another round-trip.
    for key in ("oneOf", "anyOf", "allOf"):
        if isinstance(out, dict) and isinstance(out.get(key), list):
            out[key] = [_resolve(schema, b) for b in out[key]]
    if isinstance(out, dict) and isinstance(out.get("properties"), dict):
        out["properties"] = {k: _resolve(schema, v) for k, v in out["properties"].items()}
    return {"ok": True, "uccVersion": ucc_version(), "name": match, "schema": out}
