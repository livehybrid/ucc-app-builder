"""
Splunk Agent SDK local-tool MCP server entry point.

The splunklib.ai Agent SPAWNS this file as a subprocess and speaks to it over the
MCP stdio protocol. It must therefore:
  1. Set SPLUNK_HOME — the SDK subprocess strips the environment (it only forwards
     LD_LIBRARY_PATH), but the vendored splunklib + our tools need SPLUNK_HOME.
  2. Put bin/ and lib/ on sys.path so builder_agent_tools (+ vendored splunklib)
     import (this app has no ucc-gen import_declare_test).
  3. Import builder_agent_tools so its @registry.tool() decorators register the UCC
     builder tools (tagged `ucc_builder`) on the shared ToolRegistry.
  4. Start the MCP stdio server via registry.run().
"""
import os
import sys

_bin = os.path.dirname(os.path.abspath(__file__))
if _bin not in sys.path:
    sys.path.insert(0, _bin)
_lib = os.path.join(os.path.dirname(_bin), "lib")
if os.path.isdir(_lib) and _lib not in sys.path:
    sys.path.insert(0, _lib)

# The SDK's MCP subprocess strips the environment (only forwards LD_LIBRARY_PATH).
# Infer SPLUNK_HOME from the script path: bin/ -> <app>/ -> apps/ -> etc/ -> SPLUNK_HOME
if "SPLUNK_HOME" not in os.environ:
    os.environ["SPLUNK_HOME"] = os.path.normpath(os.path.join(_bin, "..", "..", "..", ".."))
# splunk.rest (imported by builder_common) requires SPLUNK_DB, also stripped.
if "SPLUNK_DB" not in os.environ:
    os.environ["SPLUNK_DB"] = os.path.join(os.environ["SPLUNK_HOME"], "var", "lib", "splunk")

# Registers the tools on import (decorators run).
from builder_agent_tools import registry  # noqa: E402,F401

# Start the MCP stdio server so the SDK agent can communicate with our tools.
if __name__ == "__main__":
    registry.run()
