"""Static validation of UCC App Builder's MCP tool registration.

`deploy/register_mcp_tools.py` holds `TOOLS`, the single source of truth. Its
`--emit` build step writes the same definitions into the signatures file that
the in-app `bin/autoregister.py` registers from on install, so the manual and
automatic paths cannot drift. These tests assert the invariants the Splunk MCP
Server enforces, against the table and against the emitted file.

Two regressions this exists to prevent, both found 2026-07-31:

1. `tools/call` -> `-32004  Tool 'ucc_app_builder_ucc_ping' not found`.
   The MCP Server prefixes every tool name on load
   (`Tool._convert_from_new_schema`) with `_meta.name_prefix`, falling back to
   `_meta.external_app_id`, unless the name already carries that prefix, and
   publishes THAT name from `tools/list`. But `tools/call` resolves via
   `get_enabled_tool()` -> `ToolEnabledCollection.get()`, a plain `_key` lookup
   in `mcp_tools_enabled`, which registration wrote from the raw name. The two
   never met, so every tool was uncallable.

2. `bin/autoregister.py` read a signatures file that nothing ever generated.
   The `open()` threw, the handler swallowed it, and auto-registration on
   install had therefore NEVER worked in this app: the tools only existed on a
   given instance because someone ran the manual script. `test_emit_*` below
   covers that path.
"""
from __future__ import annotations

import importlib.util
import json
import os
import tempfile

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SPLUNK_APP = os.path.dirname(HERE)
REGISTER = os.path.join(SPLUNK_APP, "deploy", "register_mcp_tools.py")

APP = "ucc_app_builder"
EXPECTED_PREFIX = "ucc"
EXPECTED_TOOLS = {
    "ucc_ping",
    "ucc_create_addon",
    "ucc_write_file",
    "ucc_read_file",
    "ucc_list_project",
    "ucc_build_and_inspect",
    "ucc_package",
    "ucc_generate_dashboard",
    "ucc_generate_savedsearch",
    "ucc_generate_tests",
}


@pytest.fixture(scope="module")
def reg():
    """Import register_mcp_tools.py by path (it is a script, not a package)."""
    assert os.path.exists(REGISTER), f"missing {REGISTER}"
    spec = importlib.util.spec_from_file_location("register_mcp_tools", REGISTER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _names(mod):
    return [t[0] if isinstance(t, (list, tuple)) else t["name"] for t in mod.TOOLS]


def test_expected_tools_present(reg):
    names = set(_names(reg))
    assert names == EXPECTED_TOOLS, (
        f"TOOLS drifted: missing {EXPECTED_TOOLS - names}, unexpected {names - EXPECTED_TOOLS}"
    )


def test_name_prefix_declared(reg):
    assert reg.NAME_PREFIX == EXPECTED_PREFIX
    assert reg.APP == APP


def test_advertised_name_matches_enabled_key(reg):
    """The name tools/list advertises must equal the mcp_tools_enabled _key that
    tools/call resolves by. This is the -32004 regression guard."""
    for name in _names(reg):
        advertised = reg.mcp_name(name)
        assert advertised == name, (
            f"{name}: MCP would advertise {advertised!r} but registration enables "
            f"{name!r}. Set _meta.name_prefix to a prefix the name already carries."
        )


def test_mcp_name_is_idempotent(reg):
    """Prefixing an already-prefixed name must be a no-op; a double prefix would
    make the tool uncallable."""
    for name in _names(reg):
        once = reg.mcp_name(name)
        assert reg.mcp_name(once) == once, f"{name}: mcp_name not idempotent"


def test_mcp_name_mirrors_the_servers_rule(reg):
    assert reg.mcp_name("ping") == "ucc_ping"
    assert reg.mcp_name("ucc_ping") == "ucc_ping"


def test_emit_writes_a_parseable_signatures_file(reg):
    """Regression 2: autoregister.py reads this file on install. If --emit is
    broken or never run, the handler throws, swallows, and silently no-ops."""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "tool_input_payload_signatures.json")
        reg.emit(path)
        assert os.path.exists(path), "emit() did not write the signatures file"
        with open(path) as fh:
            tools = json.load(fh)
    assert isinstance(tools, list) and tools, "signatures file is empty"
    assert {t["name"] for t in tools} == EXPECTED_TOOLS


def test_emitted_tools_carry_name_prefix_and_app_id(reg):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "sig.json")
        reg.emit(path)
        with open(path) as fh:
            tools = json.load(fh)
    for tool in tools:
        meta = tool.get("_meta", {})
        assert meta.get("name_prefix") == EXPECTED_PREFIX, (
            f"{tool['name']}: _meta.name_prefix should be {EXPECTED_PREFIX!r}, "
            f"got {meta.get('name_prefix')!r}"
        )
        assert meta.get("external_app_id") == APP, (
            f"{tool['name']}: _meta.external_app_id should be {APP!r}"
        )


def test_emitted_input_schemas_are_flat(reg):
    """The MCP Server does not resolve $ref, so schemas must be self-contained."""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "sig.json")
        reg.emit(path)
        with open(path) as fh:
            tools = json.load(fh)
    for tool in tools:
        blob = json.dumps(tool.get("inputSchema", {}))
        for token in ("$ref", "$defs", "definitions"):
            assert token not in blob, f"{tool['name']}: inputSchema uses {token}"


def test_every_tool_has_a_usable_description(reg):
    """The description is what the model selects on."""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "sig.json")
        reg.emit(path)
        with open(path) as fh:
            tools = json.load(fh)
    for tool in tools:
        desc = tool.get("description") or ""
        assert len(desc) > 40, (
            f"{tool['name']}: description missing or too short to disambiguate ({desc!r})"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
