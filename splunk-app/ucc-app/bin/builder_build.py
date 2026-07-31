"""
Native Python build engine - runs `ucc-gen build`/`package` + Splunk AppInspect entirely
inside Splunk's python (3.13), using the ucc-framework + appinspect wheels vendored under
<app>/lib. This replaces the Node sidecar's /api/build, /api/validate, /api/ucc-version,
/api/mcp/build_engine routes (and the build_and_inspect / package agent tools).

The build itself runs in a subprocess (ucc-gen pip-installs the add-on's requirements and
imports heavy deps; isolating it keeps the persistent REST handler clean) with PYTHONPATH
pointed at the vendored lib. AppInspect runs the same way against the built app.
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

_BIN = os.path.dirname(os.path.abspath(__file__))
_APP_LIB = os.path.join(os.path.dirname(_BIN), "lib")

# ELF e_machine for AArch64; magic = 0x7F 'E' 'L' 'F'.
_EM_AARCH64 = 0xB7
_ELF_MAGIC = b"\x7fELF"

# AppInspect checks that are informational for correctly-built UCC add-ons - "No action
# required" / "please disregard". The clean determination must ignore them.
INFORMATIONAL_CHECKS = frozenset([
    "check_for_ucc_framework_version",
    "check_for_modular_inputs",
    "check_for_python_script_existence",
    "check_for_splunk_js",
    "check_for_splunk_js_header_and_footer_view",
    "check_for_indexer_synced_configs",
    "check_aarch64_compatibility",
])


def _py():
    """Interpreter for the build subprocess. The vendored ucc-framework + appinspect are
    cp313 wheels, so the build MUST run on Splunk's python 3.13 - pin it explicitly rather
    than trusting sys.executable (the REST handler may itself be running under 3.9)."""
    cand = os.path.join(os.environ.get("SPLUNK_HOME", "/opt/splunk"), "bin", "python3")
    return cand if os.path.exists(cand) else sys.executable


def _build_env():
    env = dict(os.environ)
    # Vendored ucc-framework + appinspect + their deps live here. Prepend so the build
    # subprocess imports them regardless of how splunkd set up the handler's path.
    env["PYTHONPATH"] = _APP_LIB + os.pathsep + env.get("PYTHONPATH", "")
    env.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    # Splunk's bundled python needs $SPLUNK_HOME/lib on the loader path for its libssl/
    # libcrypto - without it ucc-gen's internal `pip install` (it installs the add-on's
    # requirements during build) and any HTTPS the toolchain does fail with "ssl module
    # is not available".
    splunk_home = env.get("SPLUNK_HOME") or "/opt/splunk"
    splunk_lib = os.path.join(splunk_home, "lib")
    if os.path.isdir(splunk_lib):
        env["LD_LIBRARY_PATH"] = splunk_lib + os.pathsep + env.get("LD_LIBRARY_PATH", "")
    # ucc-gen pip-installs the add-on's package/lib/requirements.txt during build using the
    # `python3` it finds on PATH. Put $SPLUNK_HOME/bin FIRST so that's Splunk's python 3.13
    # (the add-on's runtime) - otherwise it picks up the host's python (3.10 here), installing
    # mismatched-version deps, or fails entirely if no python3 is on the handler's PATH.
    splunk_bin = os.path.join(splunk_home, "bin")
    if os.path.isdir(splunk_bin):
        env["PATH"] = splunk_bin + os.pathsep + env.get("PATH", "")
    return env


def _run(argv, cwd=None, timeout=900, on_log=None):
    """Run a subprocess, streaming combined stdout/stderr to on_log. Returns (code, lines)."""
    lines = []
    try:
        proc = subprocess.Popen(argv, cwd=cwd, env=_build_env(), stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, bufsize=1)
    except Exception as e:  # noqa: BLE001
        if on_log:
            on_log("failed to launch %s: %s" % (argv[0], e))
        return 1, ["failed to launch: %s" % e]
    try:
        for line in proc.stdout:
            line = line.rstrip("\n")
            lines.append(line)
            if on_log:
                on_log(line)
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        lines.append("[timeout after %ss]" % timeout)
        if on_log:
            on_log("[timeout after %ss]" % timeout)
        return 124, lines
    return proc.returncode or 0, lines


# --------------------------------------------------------------------------- manifest
def app_manifest_from_global_config(global_config, fallback_app_id=None):
    meta = (global_config or {}).get("meta") or {}
    app_id = (str(meta.get("name") or "").strip()
              or (str(fallback_app_id or "").strip()) or "splunk_addon")
    display = str(meta.get("displayName") or "").strip() or app_id
    return {
        "schemaVersion": "2.0.0",
        "info": {
            "title": display,
            "id": {
                "group": None,
                "name": app_id,
                "version": str(meta.get("version") or "1.0.0").strip() or "1.0.0",
            },
            "author": [{"name": meta.get("author") or "Unknown", "email": meta.get("email") or ""}],
            "description": meta.get("description") or "",
            "license": {"name": "", "uri": ""},
        },
        "supportedDeployments": ["_standalone", "_distributed", "_search_head_clustering"],
        "targetWorkloads": ["_search_heads"],
    }


# --------------------------------------------------------------------------- VFS layout
def _to_work_path(loop_path, app_id):
    """Map a builder VFS path (`<appId>/package/...`, `<appId>/globalConfig.json`) onto the
    on-disk workdir ucc-gen wants (`package/...`, root `globalConfig.json`). Returns None
    for files outside the buildable set."""
    p = re.sub(r"^/+", "", loop_path or "")
    if app_id and p.startswith(app_id + "/"):
        p = p[len(app_id) + 1:]
    if p == "globalConfig.json":
        return "globalConfig.json"
    if p.startswith("package/"):
        return p
    return None


def write_vfs(workdir, files, app_id, on_log=None):
    """Lay the project's source files into workdir and guarantee package/app.manifest."""
    gc_raw = None
    for f in files or []:
        wp = _to_work_path(f.get("path"), app_id)
        if not wp:
            continue
        dest = os.path.join(workdir, wp)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        content = f.get("content") or ""
        with open(dest, "w", encoding="utf-8") as fh:
            fh.write(content)
        if wp == "globalConfig.json":
            gc_raw = content
    # ucc-gen REQUIRES package/app.manifest but does NOT generate it - synthesise from
    # globalConfig.json when absent (idempotent: skipped if a manifest was written above).
    manifest_path = os.path.join(workdir, "package", "app.manifest")
    if not os.path.isfile(manifest_path) and gc_raw:
        try:
            gc = json.loads(gc_raw)
            manifest = app_manifest_from_global_config(gc, app_id)
            os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
            with open(manifest_path, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(manifest, indent=2))
            if on_log:
                on_log("Generated required package/app.manifest from globalConfig.json.")
        except Exception as e:  # noqa: BLE001
            if on_log:
                on_log("Could not auto-generate app.manifest: %s" % e)


# --------------------------------------------------------------------------- binary strip
def _elf_machine(path):
    try:
        with open(path, "rb") as fh:
            head = fh.read(20)
        if len(head) < 20 or head[:4] != _ELF_MAGIC:
            return None
        be = head[5] == 2
        return struct.unpack(">H" if be else "<H", head[18:20])[0]
    except Exception:
        return None


def strip_incompatible_binaries(app_root, on_log=None):
    """Drop native binaries that aren't aarch64 so the package passes AppInspect
    check_aarch64_compatibility (.pyd/.dll/.dylib never belong in a Linux add-on; .so kept
    only if it's an aarch64 ELF). Returns the app-relative paths removed."""
    removed = []
    for dirpath, _dirs, names in os.walk(app_root):
        for name in names:
            lower = name.lower()
            is_so = bool(re.search(r"\.so(\.\d+)*$", lower))
            is_win = lower.endswith(".pyd") or lower.endswith(".dll")
            is_mac = lower.endswith(".dylib")
            if not (is_so or is_win or is_mac):
                continue
            full = os.path.join(dirpath, name)
            drop = is_win or is_mac
            if is_so:
                drop = _elf_machine(full) != _EM_AARCH64
            if drop:
                try:
                    os.remove(full)
                    removed.append(os.path.relpath(full, app_root))
                except OSError:
                    pass
    if removed and on_log:
        shown = ", ".join(removed[:10]) + (" (+%d more)" % (len(removed) - 10) if len(removed) > 10 else "")
        on_log("Stripped %d non-aarch64 native binarie(s) for AppInspect: %s" % (len(removed), shown))
    return removed


# --------------------------------------------------------------------------- ucc-gen
def ucc_version():
    code, lines = _run([_py(), "-c",
                        'import splunk_add_on_ucc_framework as u; print(getattr(u, "__version__", ""))'],
                       timeout=60)
    ver = (lines[-1].strip() if lines else "") if code == 0 else ""
    if ver:
        return {"version": ver, "available": True}
    return {"version": None, "available": False,
            "error": "ucc-gen not importable: %s" % ("; ".join(lines[-3:]) or "unknown")}


def validate_config(global_config):
    errors, warnings = [], []
    cfg = global_config if isinstance(global_config, dict) else {}
    meta = cfg.get("meta")
    if not meta:
        errors.append("Missing required field: meta")
    else:
        for k in ("name", "restRoot", "version", "displayName"):
            if not meta.get(k):
                errors.append("Missing required field: meta.%s" % k)
    if not cfg.get("pages"):
        warnings.append("No pages defined - app will have no UI")
    return {"valid": len(errors) == 0, "errors": errors, "warnings": warnings}


def _pip_version():
    """The installer python's current pip version, e.g. '24.0'. Used to pin ucc-gen's
    `--pip-version` so its pre-install `pip install --upgrade pip` becomes a no-op (already
    satisfied) instead of MUTATING Splunk's global pip on every build."""
    try:
        code, lines = _run([_py(), "-m", "pip", "--version"], timeout=30)
        if code == 0:
            for ln in lines:
                m = re.search(r"\bpip\s+(\d+\.\d+(?:\.\d+)?)", ln)
                if m:
                    return m.group(1)
    except Exception:
        pass
    return None


def _ucc_build(workdir, version, on_log):
    output_dir = os.path.join(workdir, "output")
    argv = [_py(), "-m", "splunk_add_on_ucc_framework", "build",
            "--source", os.path.join(workdir, "package"), "--output", output_dir]
    if version:
        argv += ["--ta-version", str(version)]
    # Pin pip to the installed version so ucc-gen's mandatory `pip install --upgrade pip`
    # (it runs before installing the add-on's requirements into output/<app>/lib) is a
    # no-op and does not modify Splunk's global python.
    pv = _pip_version()
    if pv:
        argv += ["--pip-version", pv]
    on_log("Running: ucc-gen build --source package --output output%s%s"
           % (" --ta-version %s" % version if version else "",
              " --pip-version %s" % pv if pv else ""))
    code, _lines = _run(argv, cwd=workdir, timeout=900, on_log=on_log)
    if code != 0:
        raise RuntimeError("ucc-gen build failed with code %s" % code)
    return output_dir


def _ucc_package(workdir, built_app_dir, on_log):
    argv = [_py(), "-m", "splunk_add_on_ucc_framework", "package", "--path", built_app_dir]
    on_log("Running: ucc-gen package --path %s" % os.path.basename(built_app_dir))
    code, lines = _run(argv, cwd=workdir, timeout=300, on_log=on_log)
    if code != 0:
        raise RuntimeError("ucc-gen package failed with code %s" % code)
    tarball = ""
    for line in lines:
        m = re.search(r"exported to\s+(.+?\.(?:tar\.gz|tgz))", line, re.IGNORECASE)
        if m:
            tarball = m.group(1).strip()
            continue
        s = line.strip()
        if (s.endswith(".tar.gz") or s.endswith(".tgz")) and os.path.isabs(s):
            tarball = s
    return tarball


# --------------------------------------------------------------------------- appinspect
def _normalise_check(raw):
    msgs = raw.get("messages") or []
    msg = ""
    for m in msgs:
        if m.get("message"):
            msg = m.get("message")
            break
    return {
        "check": raw.get("name") or raw.get("check") or "",
        "description": raw.get("description") or "",
        "result": raw.get("result") or "",
        "message": msg,
    }


def run_appinspect(target, on_log):
    """Run splunk-appinspect against a built app dir or tarball. Returns
    {summary, checks, source} (source='cli' or 'stub' when appinspect isn't importable)."""
    out_file = os.path.join(tempfile.gettempdir(), "appinspect-%d.json" % os.getpid())
    runner = (
        "import sys;"
        "sys.argv=['splunk-appinspect','inspect',%r,'--output-file',%r,'--mode','precert'];"
        "from splunk_appinspect.main import execute;\n"
        "try:\n execute()\nexcept SystemExit:\n pass\n"
    ) % (target, out_file)
    on_log("Running: splunk-appinspect inspect --mode precert")
    code, lines = _run([_py(), "-c", runner], timeout=600, on_log=on_log)
    summary, checks = {}, []
    try:
        with open(out_file, "r", encoding="utf-8") as fh:
            parsed = json.load(fh)
        summary = parsed.get("summary") or {}
        for report in parsed.get("reports") or []:
            for group in report.get("groups") or []:
                for c in group.get("checks") or []:
                    checks.append(_normalise_check(c))
    except Exception:
        if not checks:
            return {"summary": {"skipped": 1}, "checks": [],
                    "source": "stub",
                    "raw": "AppInspect produced no report (exit %s): %s" % (code, "; ".join(lines[-3:]))}
    finally:
        try:
            os.remove(out_file)
        except OSError:
            pass
    return {"summary": summary, "checks": checks, "source": "cli"}


def _blocking_failures(report, include_warnings):
    bad = []
    for c in report.get("checks") or []:
        if c.get("check") in INFORMATIONAL_CHECKS:
            continue
        res = (c.get("result") or "").lower()
        if res in ("failure", "error") or (include_warnings and res == "warning"):
            bad.append(c)
    return bad


# --------------------------------------------------------------------------- orchestrate
def _prevalidate_global_config(files, on_log):
    """Schema-check globalConfig.json before ucc-gen. Returns a list of actionable error
    strings ([] = pass, or the check could not run - never block on our own failure)."""
    gc = next((f for f in (files or [])
               if str(f.get("path", "")).replace("\\", "/").split("/")[-1] == "globalConfig.json"),
              None)
    if not gc:
        return []
    try:
        import builder_schema
        res = builder_schema.validate_global_config_text(gc.get("content") or "")
    except Exception as e:  # noqa: BLE001 - a broken pre-check must never block a build
        on_log("globalConfig pre-validation skipped: %s" % e)
        return []
    if not res.get("checked"):
        on_log("globalConfig pre-validation skipped: %s" % (res.get("note") or "unavailable"))
        return []
    if res.get("ok"):
        on_log("globalConfig.json passed UCC %s schema validation" % (res.get("uccVersion") or "?"))
        return []
    errs = list(res.get("errors") or [])
    on_log("globalConfig.json FAILED UCC schema validation (%d issue(s))" % len(errs))
    for e in errs:
        on_log("  " + e)
    return errs


def build_and_inspect(files, app_id, version="1.0.0", do_package=False, include_warnings=False):
    """Build the project with ucc-gen, run AppInspect, and (optionally) package it.
    Returns a dict mirroring the old sidecar build_engine result:
    {clean, iterations, summary, trace, files, tarball?, report}."""
    logs = []

    def log(line):
        if line is not None and str(line).strip():
            logs.append(str(line))

    # Pre-flight: validate globalConfig.json against the REAL ucc-framework schema before
    # spending ~15 minutes in ucc-gen. ucc-gen itself only surfaces jsonschema's best_match
    # string, which for the InputsPage `oneOf` names the wrong property and sends an LLM into
    # an add-the-table / remove-the-table loop. See builder_schema for the detail.
    schema_errors = _prevalidate_global_config(files, log)
    if schema_errors:
        return {
            "ok": False,
            "clean": False,
            "error": "globalConfig.json failed UCC schema validation",
            "schemaErrors": schema_errors,
            "buildError": "\n".join(schema_errors),
            "trace": logs,
            "files": files,
        }

    workdir = tempfile.mkdtemp(prefix="ucc_build_")
    try:
        try:
            write_vfs(workdir, files, app_id, on_log=log)
            output_dir = _ucc_build(workdir, version, log)
            built = None
            try:
                entries = [d for d in os.listdir(output_dir) if os.path.isdir(os.path.join(output_dir, d))]
                built = os.path.join(output_dir, entries[0]) if entries else output_dir
            except OSError:
                built = output_dir

            strip_incompatible_binaries(built, on_log=log)
            report = run_appinspect(built, log)
            summary = report.get("summary") or {}
            # `clean` is authoritative from AppInspect's OWN summary categorisation: only
            # `failure` + `error` block packaging. A `future_failure` (a check that passes now
            # but will fail after a future deprecation date - note its per-check result is
            # still "failure", so we must NOT count it by result) and `warning` are ADVISORY.
            n_fail = int(summary.get("failure", 0) or 0) + int(summary.get("error", 0) or 0)
            clean = n_fail == 0
            blocking = _blocking_failures(report, include_warnings) if not clean else []
            advisories = {"future_failure": int(summary.get("future_failure", 0) or 0),
                          "warning": int(summary.get("warning", 0) or 0)}

            tarball = None
            if do_package:
                tarball = _ucc_package(workdir, built, log) or None
                if tarball:
                    log("Package exported: %s" % tarball)

            result = {
                "ok": True,
                "clean": clean,
                "iterations": 1,
                "summary": summary,
                "report": report,
                "blocking": [b.get("check") for b in blocking],
                "advisories": advisories,  # future_failure / warning counts (non-blocking)
                "trace": logs,
                "files": [],  # native build does not auto-edit source; the agent applies fixes
            }
            if tarball:
                result["tarball"] = tarball
            return result
        except Exception as e:  # noqa: BLE001
            # ucc-gen / package failed. The captured output (in `logs`) is the ONLY way the
            # agent and the user can see WHY - return it instead of letting the exception
            # propagate as an opaque "build failed with code 1". `buildError` is the tail of
            # ucc-gen's own stderr (its tracebacks/errors are streamed there).
            tail = [ln for ln in logs[-30:] if ln.strip()]
            return {
                "ok": False,
                "clean": False,
                "iterations": 1,
                "error": str(e),
                "buildError": "\n".join(tail),
                "summary": {},
                "trace": logs,
                "files": [],
            }
    finally:
        # Keep the tarball (copied out by the caller if needed); drop the rest.
        if not do_package:
            shutil.rmtree(workdir, ignore_errors=True)
