/**
 * Curated Splunk Python SDK + UCC helper reference for LLM/tool consumption.
 *
 * Goal: keep an always-available, self-hostable reference the agent can query
 * without internet access. This prevents "hallucinated" API calls and nudges
 * generated code toward real Splunk/UCC patterns.
 */

export interface SplunkSymbolRef {
  symbol: string;
  signature: string;
  module: string;
  category: 'splunklib.modularinput' | 'splunklib.searchcommands' | 'splunktaucclib' | 'solnlib';
  description: string;
  example?: string;
}

export const SPLUNK_SDK_REFERENCE: SplunkSymbolRef[] = [
  {
    symbol: 'Script',
    signature: 'class Script',
    module: 'splunklib.modularinput',
    category: 'splunklib.modularinput',
    description:
      'Base class for Splunk modular inputs. Override get_scheme, validate_input, and stream_events.',
    example: 'class MyInput(Script): ...',
  },
  {
    symbol: 'Scheme',
    signature: 'Scheme(title: str)',
    module: 'splunklib.modularinput',
    category: 'splunklib.modularinput',
    description: 'Defines modular input metadata and argument schema.',
  },
  {
    symbol: 'Argument',
    signature: 'Argument(name: str, **kwargs)',
    module: 'splunklib.modularinput',
    category: 'splunklib.modularinput',
    description: 'Represents one input parameter in get_scheme().',
  },
  {
    symbol: 'Event',
    signature: 'Event(data: str = "", stanza: str = "", **kwargs)',
    module: 'splunklib.modularinput',
    category: 'splunklib.modularinput',
    description: 'Represents one event emitted by a modular input.',
  },
  {
    symbol: 'EventWriter.write_event',
    signature: 'write_event(event: Event) -> None',
    module: 'splunklib.modularinput',
    category: 'splunklib.modularinput',
    description: 'Writes a single event to Splunk from stream_events.',
  },
  {
    symbol: 'dispatch',
    signature: 'dispatch(command_class, argv, stdin, stdout, module_name)',
    module: 'splunklib.searchcommands',
    category: 'splunklib.searchcommands',
    description: 'Entrypoint for custom search commands.',
  },
  {
    symbol: 'StreamingCommand',
    signature: 'class StreamingCommand(SearchCommand)',
    module: 'splunklib.searchcommands',
    category: 'splunklib.searchcommands',
    description: 'Base class for streaming custom search commands.',
  },
  {
    symbol: 'GeneratingCommand',
    signature: 'class GeneratingCommand(SearchCommand)',
    module: 'splunklib.searchcommands',
    category: 'splunklib.searchcommands',
    description: 'Base class for generating commands that produce events.',
  },
  {
    symbol: 'ReportingCommand',
    signature: 'class ReportingCommand(SearchCommand)',
    module: 'splunklib.searchcommands',
    category: 'splunklib.searchcommands',
    description: 'Base class for reporting commands with map/reduce phases.',
  },
  {
    symbol: 'Configuration',
    signature: '@Configuration(**kwargs)',
    module: 'splunklib.searchcommands',
    category: 'splunklib.searchcommands',
    description: 'Decorator for command metadata (e.g. distributed, type, etc.).',
  },
  {
    symbol: 'Option',
    signature: 'Option(**kwargs)',
    module: 'splunklib.searchcommands',
    category: 'splunklib.searchcommands',
    description: 'Declares command arguments for search commands.',
  },
  {
    symbol: 'BaseModInput',
    signature:
      'class BaseModInput(app_name: str, input_name: str, use_single_instance: bool = False)',
    module: 'splunktaucclib.modinput_wrapper.base_modinput',
    category: 'splunktaucclib',
    description: 'UCC toolkit base class for generated modular inputs using helper modules.',
  },
  {
    symbol: 'ModularInputHelper.get_arg',
    signature: 'get_arg(name: str) -> str | None',
    module: 'splunktaucclib.modinput_wrapper',
    category: 'splunktaucclib',
    description: 'Reads an input parameter from the current stanza.',
  },
  {
    symbol: 'ModularInputHelper.send_http_request',
    signature: 'send_http_request(url: str, method: str, **kwargs) -> Response',
    module: 'splunktaucclib.modinput_wrapper',
    category: 'splunktaucclib',
    description: 'Wrapper for HTTP calls from helper-based modular inputs.',
  },
  {
    symbol: 'ModularInputHelper.new_event',
    signature:
      'new_event(data: str, source: str | None = None, sourcetype: str | None = None, index: str | None = None)',
    module: 'splunktaucclib.modinput_wrapper',
    category: 'splunktaucclib',
    description: 'Creates an event object for ew.write_event().',
  },
  {
    symbol: 'KVStoreCheckpoint',
    signature: 'KVStoreCheckpoint(collection_name: str, session_key: str, app: str)',
    module: 'solnlib.modular_input.checkpointer',
    category: 'solnlib',
    description: 'Checkpoint storage helper for incremental data collection.',
  },
  {
    symbol: 'CredentialManager',
    signature: 'CredentialManager(session_key: str, app: str, owner: str = "nobody")',
    module: 'solnlib.credentials',
    category: 'solnlib',
    description: 'Reads/writes encrypted credentials in Splunk storage.',
  },
];

export function searchSplunkSdkReference(query: string, limit = 10): SplunkSymbolRef[] {
  const q = query.trim().toLowerCase();
  if (!q) return SPLUNK_SDK_REFERENCE.slice(0, limit);
  const scored = SPLUNK_SDK_REFERENCE.map((entry) => {
    let score = 0;
    if (entry.symbol.toLowerCase() === q) score += 100;
    if (entry.symbol.toLowerCase().includes(q)) score += 30;
    if (entry.signature.toLowerCase().includes(q)) score += 20;
    if (entry.module.toLowerCase().includes(q)) score += 10;
    if (entry.description.toLowerCase().includes(q)) score += 5;
    return { entry, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map((x) => x.entry);
}

export function formatSplunkSdkEntries(entries: SplunkSymbolRef[]): string {
  if (!entries.length) return 'No matching Splunk SDK symbols found.';
  return entries
    .map((e) =>
      [
        `- ${e.symbol}`,
        `  module: ${e.module}`,
        `  signature: ${e.signature}`,
        `  description: ${e.description}`,
        e.example ? `  example: ${e.example}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n');
}
