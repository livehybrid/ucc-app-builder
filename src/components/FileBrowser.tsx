import { useState, useCallback, useEffect, useRef } from 'react';
import styled from 'styled-components';
import Editor, { OnMount } from '@monaco-editor/react';
import Button from '@splunk/react-ui/Button';
import Message from '@splunk/react-ui/Message';
import Modal from '@splunk/react-ui/Modal';
import Text from '@splunk/react-ui/Text';
import Menu from '@splunk/react-ui/Menu';
import Badge from '@splunk/react-ui/Badge';
import Switch from '@splunk/react-ui/Switch';
import Select from '@splunk/react-ui/Select';
import {
  fetchCompletion,
  inlineEnabled,
  setInlineEnabled,
  inlineModel,
  COMPLETION_MODEL_STORAGE,
  COMPLETION_MODEL_CHOICES,
} from '../lib/ai/inlineCompletion';
import { variables } from '@splunk/themes';
import type { VirtualFileSystem } from '../lib/vfs';
import type { VFSNode, VFSDirectory, VFSFile } from '../types/vfs';
import { SpecParser } from '../lib/specParser';
import { SPLUNK_SPECS } from '../lib/splunkSpecs';
import { SPLUNK_SDK_REFERENCE } from '../lib/splunkSdkReference';
import uccSchema from '../lib/uccSchema.json';
import type { WizardState } from '../types/app';
import { ComponentsStep } from './wizard/ComponentsStep';
import type { ComponentsConfig } from '../types/components';

interface FileBrowserProps {
  vfs: VirtualFileSystem;
  wizardState?: WizardState;
  developerMode?: boolean;
  onUpdateConfig?: (newState: WizardState) => void;
}

// Monaco language services are global; FileBrowser remounts on every VFS
// change (keyed by vfsVersion), so guards must live at module scope or the
// completion/hover providers re-register on each remount and suggestions
// duplicate.
let confLanguageRegistered = false;
let pythonAssistRegisteredGlobal = false;
// The conf completion provider is registered ONCE (above guards) but needs the
// CURRENTLY-mounted FileBrowser's selected file. A component ref captured in
// the provider closure goes stale after the first vfsVersion remount (the old
// instance's ref stops updating), silently killing all .conf suggestions —
// so the live path is mirrored into module scope instead.
let activeEditorPath: string | null = null;

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetPath: string;
  targetType: 'file' | 'directory';
}

const Toolbar = styled.div`
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  align-items: center;
  flex-shrink: 0;
`;

const ToolbarSpacer = styled.div`
  flex: 1;
`;

const BrowserContainer = styled.div`
  display: flex;
  gap: 16px;
  flex: 1;
  min-height: 0;
`;

const FileTree = styled.div`
  width: 280px;
  min-width: 200px;
  background: ${variables.backgroundColorDialog};
  border-radius: 6px;
  border: 1px solid ${variables.borderColor};
  padding: 8px;
  overflow-y: auto;
  font-size: 0.875rem;
`;

const TreeItem = styled.div<{ $depth: number; $selected?: boolean; $isDir?: boolean }>`
  padding: 6px 8px;
  padding-left: ${(props) => props.$depth * 16 + 8}px;
  cursor: pointer;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
  user-select: none;
  color: ${(props) => (props.$isDir ? '#65A637' : 'inherit')};
  background: ${(props) => (props.$selected ? 'rgba(101, 166, 55, 0.3)' : 'transparent')};

  &:hover {
    background: ${(props) =>
      props.$selected ? 'rgba(101, 166, 55, 0.3)' : 'rgba(255,255,255,0.05)'};
  }
`;

const FileContent = styled.div`
  flex: 1;
  background: #1e1e1e;
  border-radius: 6px;
  overflow: hidden;
  min-width: 0;
  border: 1px solid ${variables.borderColor};
`;

const EmptyState = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #9b9ea3;
`;

const ImagePreview = styled.div`
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #1e1e1e;
  padding: 32px;
`;

const ImageContainer = styled.div`
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  width: 100%;

  img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border: 1px solid ${variables.borderColor};
  }
`;

const ContextMenuOverlay = styled.div<{ $x: number; $y: number }>`
  position: fixed;
  left: ${(props) => props.$x}px;
  top: ${(props) => props.$y}px;
  z-index: 1000;
`;

// Helper to determine if a node should be visible in standard mode
const isVisible = (node: VFSNode, developerMode: boolean): boolean => {
  if (developerMode) return true;

  if (node.type === 'file') {
    // Always show user-created or modified files
    if (node.source !== 'generated') return true;

    // Show specific generated files that are meant to be edited
    const isHelper = node.name.endsWith('_helper.py');
    const isLib = node.path.includes('/package/lib/');
    const isStatic = node.path.includes('/package/static/');
    const isRootConfig =
      node.path.endsWith('/globalConfig.json') || node.path.endsWith('/app.manifest');
    return isHelper || isLib || isStatic || isRootConfig;
  }

  // For directories, show if any child is visible
  if (node.type === 'directory') {
    for (const child of node.children.values()) {
      if (isVisible(child, developerMode)) return true;
    }
    // Also show empty source directories like 'lib' if they exist
    if (node.name === 'lib' || node.name === 'bin') return true;
    return false;
  }

  return false;
};

export function FileBrowser({
  vfs,
  wizardState,
  developerMode = false,
  onUpdateConfig,
}: FileBrowserProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['/']));
  // Inline (ghost-text) AI completion — opt-in (default OFF), persisted in localStorage.
  const [aiComplete, setAiComplete] = useState<boolean>(() => inlineEnabled());
  const [completeModel, setCompleteModel] = useState<string>(() => inlineModel());
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    targetPath: '',
    targetType: 'file',
  });
  const [newItemModal, setNewItemModal] = useState<{
    visible: boolean;
    type: 'file' | 'folder';
    parentPath: string;
  }>({
    visible: false,
    type: 'file',
    parentPath: '',
  });
  const [newItemName, setNewItemName] = useState('');
  const [renameModal, setRenameModal] = useState<{
    visible: boolean;
    path: string;
    currentName: string;
  }>({
    visible: false,
    path: '',
    currentName: '',
  });
  const [renameName, setRenameName] = useState('');
  const [, forceUpdate] = useState({});
  const [showComponentsModal, setShowComponentsModal] = useState(false);
  const [tempComponentsConfig, setTempComponentsConfig] = useState<ComponentsConfig | null>(null);

  const selectedContent = selectedPath ? vfs.readFile(selectedPath) : null;
  const displayContent = hasUnsavedChanges ? editedContent : selectedContent;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monacoRef = useRef<any>(null);
  const specParser = useRef(new SpecParser());
  const modalReturnRef = useRef<HTMLButtonElement>(null);
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  activeEditorPath = selectedPath;

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    const applySchema = (schema: unknown, uri: string) => {
      monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
        validate: true,
        schemas: [{ uri, fileMatch: ['globalConfig.json'], schema }],
      });
    };

    // Start with the bundled subset, then upgrade to the AUTHORITATIVE schema
    // extracted from the installed ucc-gen package (server endpoint) — full
    // entity/validator definitions, always matching the build engine version.
    applySchema(uccSchema, 'ucc://schema/bundled-subset');
    fetch('/api/ucc/schema')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { schema?: unknown; uccVersion?: string }) => {
        if (d?.schema) applySchema(d.schema, `ucc://schema/ucc-gen-${d.uccVersion ?? 'live'}`);
      })
      .catch(() => {
        // Server offline — bundled subset stays active.
      });

    // Add Save Command (Ctrl+S / Cmd+S)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const currentPath = selectedPathRef.current;
      if (currentPath) {
        // Use editor.getValue() to get the most up-to-date content directly from Monaco
        const content = editor.getValue();
        vfs.writeFile(currentPath, content);

        // Update state to reflect saved status
        setEditedContent(content);
        setHasUnsavedChanges(false);
        refreshTree();
      }
    });

    if (confLanguageRegistered) return;
    confLanguageRegistered = true;

    monaco.languages.register({ id: 'splunk-conf' });

    // Syntax highlighting for .conf/.meta — the language was previously
    // registered without a tokenizer, so conf files rendered as plain text.
    monaco.languages.setMonarchTokensProvider('splunk-conf', {
      tokenizer: {
        root: [
          [/^\s*#.*$/, 'comment'],
          [/^\s*\[[^\]]*\]\s*$/, 'keyword'], // stanza header
          [/^([^=#[\]]+?)(\s*=\s*)/, ['attribute.name', 'delimiter'], '@value'],
        ],
        value: [
          [/\b(true|false|0|1)\s*$/, 'constant', '@pop'],
          [/\$[^$]+\$/, 'variable'], // $token$ substitutions
          [/\\$/, 'string.escape', '@pop'], // line continuation
          [/.$/, 'string', '@pop'],
          [/./, 'string'],
        ],
      },
    });

    monaco.languages.setLanguageConfiguration('splunk-conf', {
      comments: { lineComment: '#' }, // enables Ctrl+/ comment toggling
      brackets: [['[', ']']],
      autoClosingPairs: [
        { open: '[', close: ']' },
        { open: '"', close: '"' },
      ],
      surroundingPairs: [{ open: '[', close: ']' }],
    });

    // Fold each [stanza] block.
    monaco.languages.registerFoldingRangeProvider('splunk-conf', {
      provideFoldingRanges: (model: {
        getLineCount: () => number;
        getLineContent: (line: number) => string;
      }) => {
        const ranges: { start: number; end: number }[] = [];
        let start: number | null = null;
        const total = model.getLineCount();
        for (let i = 1; i <= total; i++) {
          const line = model.getLineContent(i).trim();
          if (line.startsWith('[') && line.endsWith(']')) {
            if (start !== null && i - 1 > start) ranges.push({ start, end: i - 1 });
            start = i;
          }
        }
        if (start !== null && total > start) ranges.push({ start, end: total });
        return ranges;
      },
    });

    monaco.languages.registerCompletionItemProvider('splunk-conf', {
      triggerCharacters: ['[', '=', ' '],
      provideCompletionItems: (
        model: {
          getValueInRange: (range: {
            startLineNumber: number;
            startColumn: number;
            endLineNumber: number;
            endColumn: number;
          }) => string;
          getLineContent: (line: number) => string;
        },
        position: { lineNumber: number; column: number }
      ) => {
        const textUntilPosition = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });

        // Module-scope mirror of the mounted instance's selected path — a
        // component ref here goes stale after the first remount (see above).
        const currentPath = activeEditorPath;
        const filename = currentPath?.split('/').pop() || '';
        const specContent = SPLUNK_SPECS[filename];
        if (!specContent) return { suggestions: [] };

        const spec = specParser.current.parse(filename + '.spec', specContent);
        const suggestions: {
          label: string;
          kind: number;
          insertText: string;
          documentation?: string;
          range?: {
            startLineNumber: number;
            startColumn: number;
            endLineNumber: number;
            endColumn: number;
          };
        }[] = [];

        // 1. Stanza suggestions: when typing `[` or on an empty line
        if (textUntilPosition.trim() === '[' || textUntilPosition.trim() === '') {
          spec.stanzas.forEach((s) => {
            suggestions.push({
              label: `[${s.name}]`,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: s.name.includes('<') ? s.name : `[${s.name}]`,
              documentation: s.description,
              range: {
                startLineNumber: position.lineNumber,
                startColumn: textUntilPosition.indexOf('[') + 1 || 1,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
              },
            });
          });
        }

        // 2. Find the current stanza context by scanning upward
        let currentStanzaName: string | null = null;
        for (let i = position.lineNumber - 1; i >= 1; i--) {
          const line = model.getLineContent(i).trim();
          if (line.startsWith('[') && line.endsWith(']')) {
            currentStanzaName = line.slice(1, -1);
            break;
          }
        }

        // Also check the current line for stanza context
        const currentLine = model.getLineContent(position.lineNumber).trim();
        if (currentLine.startsWith('[') && currentLine.endsWith(']')) {
          currentStanzaName = currentLine.slice(1, -1);
        }

        // 3. Parameter suggestions: when inside a stanza and not in a value assignment
        if (currentStanzaName && !textUntilPosition.includes('=')) {
          // Try exact match first, then regex/wildcard stanzas
          const stanzaSpec =
            spec.stanzas.find((s) => {
              if (s.matchType === 'exact') return s.name === currentStanzaName;
              return false;
            }) ||
            spec.stanzas.find((s) => {
              if (s.matchType === 'regex' && s.pattern) return s.pattern.test(currentStanzaName!);
              return false;
            });

          if (stanzaSpec) {
            stanzaSpec.params.forEach((p) => {
              suggestions.push({
                label: p.name,
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: `${p.name} = `,
                documentation: p.description,
              });
            });
          }

          // Also include params from the [default] stanza if available and we're not already in it
          if (currentStanzaName !== 'default') {
            const defaultStanza = spec.stanzas.find((s) => s.name === 'default');
            if (defaultStanza) {
              defaultStanza.params.forEach((p) => {
                // Avoid duplicates
                if (!suggestions.some((s) => s.label === p.name)) {
                  suggestions.push({
                    label: p.name,
                    kind: monaco.languages.CompletionItemKind.Property,
                    insertText: `${p.name} = `,
                    documentation: `(from [default]) ${p.description || ''}`,
                  });
                }
              });
            }
          }
        }

        // 4. Value suggestions: when after `=`
        if (textUntilPosition.includes('=')) {
          // Find the key name to provide context-specific values
          const keyName = textUntilPosition.split('=')[0].trim();

          // Provide common boolean values
          suggestions.push(
            { label: 'true', kind: monaco.languages.CompletionItemKind.Value, insertText: 'true' },
            { label: 'false', kind: monaco.languages.CompletionItemKind.Value, insertText: 'false' }
          );

          // Provide context-specific values for known keys
          if (keyName === 'disabled' || keyName === 'state') {
            suggestions.push(
              {
                label: 'enabled',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: 'enabled',
              },
              {
                label: 'disabled',
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: 'disabled',
              }
            );
          }
          if (keyName === 'KV_MODE') {
            ['auto', 'none', 'multi', 'json', 'xml'].forEach((v) => {
              suggestions.push({
                label: v,
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: v,
              });
            });
          }
          if (keyName === 'datatype') {
            ['event', 'metric'].forEach((v) => {
              suggestions.push({
                label: v,
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: v,
              });
            });
          }
          if (keyName === 'payload_format') {
            ['json', 'xml'].forEach((v) => {
              suggestions.push({
                label: v,
                kind: monaco.languages.CompletionItemKind.Value,
                insertText: v,
              });
            });
          }
        }

        return { suggestions };
      },
    });

    if (!pythonAssistRegisteredGlobal) {
      pythonAssistRegisteredGlobal = true;

      monaco.languages.registerCompletionItemProvider('python', {
        triggerCharacters: ['.', '(', '_'],
        provideCompletionItems: () => {
          const suggestions = SPLUNK_SDK_REFERENCE.map((item) => ({
            label: item.symbol,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: item.symbol,
            detail: item.signature,
            documentation: `${item.module}\n\n${item.description}`,
          }));

          const uccSnippets = [
            {
              label: 'UCC stream_events helper',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: [
                'def stream_events(helper, ew):',
                '    """Collect and emit events."""',
                '    data = {"status": "ok"}',
                '    event = helper.new_event(',
                '        source="${1:my_input}",',
                '        index=helper.get_output_index(),',
                '        sourcetype="${2:my_sourcetype}",',
                '        data=json.dumps(data),',
                '    )',
                '    ew.write_event(event)',
              ].join('\n'),
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'UCC helper-style stream_events template.',
            },
            {
              label: 'splunklib modular input skeleton',
              kind: monaco.languages.CompletionItemKind.Snippet,
              insertText: [
                'class ${1:MyInput}(Script):',
                '    def get_scheme(self):',
                '        scheme = Scheme("${2:my_input}")',
                '        scheme.add_argument(Argument(name="name", required_on_create=True))',
                '        return scheme',
                '',
                '    def validate_input(self, definition):',
                '        return',
                '',
                '    def stream_events(self, inputs, ew):',
                '        for stanza, item in inputs.inputs.items():',
                '            event = Event(data="${3:payload}", stanza=stanza)',
                '            ew.write_event(event)',
              ].join('\n'),
              insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              documentation: 'splunklib modular input skeleton.',
            },
          ];

          return { suggestions: [...suggestions, ...uccSnippets] };
        },
      });

      monaco.languages.registerHoverProvider('python', {
        provideHover: (
          model: {
            getWordAtPosition: (position: {
              lineNumber: number;
              column: number;
            }) => { word: string } | null;
          },
          position: { lineNumber: number; column: number }
        ) => {
          const word = model.getWordAtPosition(position)?.word;
          if (!word) return null;
          const match = SPLUNK_SDK_REFERENCE.find(
            (entry) => entry.symbol === word || entry.symbol.endsWith(`.${word}`)
          );
          if (!match) return null;
          return {
            contents: [
              { value: `**${match.symbol}**` },
              { value: `\`${match.signature}\`` },
              { value: `${match.module}` },
              { value: `${match.description}` },
            ],
          };
        },
      });

      // Inline (ghost-text) AI completion. Registered once (global), gated at call time by
      // the opt-in flag. Debounced + cancelled via Monaco's token; fetchCompletion caches
      // and is fail-soft (returns '' — never throws into the editor).
      monaco.languages.registerInlineCompletionsProvider(['splunk-conf', 'python', 'json'], {
        provideInlineCompletions: async (
          model: {
            getOffsetAt: (p: { lineNumber: number; column: number }) => number;
            getValue: () => string;
            getLanguageId: () => string;
          },
          position: { lineNumber: number; column: number },
          _ctx: unknown,
          token: {
            isCancellationRequested: boolean;
            onCancellationRequested: (cb: () => void) => void;
          }
        ) => {
          if (!inlineEnabled()) return { items: [] };
          // Debounce: wait out a typing burst; bail if Monaco superseded this request.
          await new Promise((r) => setTimeout(r, 350));
          if (token.isCancellationRequested) return { items: [] };
          const offset = model.getOffsetAt(position);
          const full = model.getValue();
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          const text = await fetchCompletion(
            {
              prefix: full.slice(0, offset),
              suffix: full.slice(offset),
              language: model.getLanguageId(),
            },
            controller.signal
          );
          if (!text || token.isCancellationRequested) return { items: [] };
          return {
            items: [
              {
                insertText: text,
                range: new monaco.Range(
                  position.lineNumber,
                  position.column,
                  position.lineNumber,
                  position.column
                ),
              },
            ],
          };
        },
        freeInlineCompletions: () => {
          /* nothing to dispose */
        },
      });
    }
  };

  // Validation Effect
  useEffect(() => {
    if (
      !selectedPath ||
      !selectedPath.endsWith('.conf') ||
      !editorRef.current ||
      !monacoRef.current
    )
      return;
    const filename = selectedPath.split('/').pop()!;
    const specContent = SPLUNK_SPECS[filename];
    if (!specContent) {
      // Clear any previous markers if we switch to a file with no spec
      const model = editorRef.current.getModel();
      if (model) monacoRef.current.editor.setModelMarkers(model, 'splunk-conf', []);
      return;
    }
    const spec = specParser.current.parse(filename + '.spec', specContent);
    const model = editorRef.current.getModel();
    const content = displayContent || '';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const markers: any[] = [];
    const lines = content.split('\n');
    let currentStanzaName: string | null = null;

    // Collect all known params across all stanzas for lenient validation on dynamic stanzas
    const allKnownParams = new Set<string>();
    spec.stanzas.forEach((s) => s.params.forEach((_, key) => allKnownParams.add(key)));

    // Duplicate detection: btool keeps only the last occurrence, so duplicate
    // stanzas/keys are silent config-eating bugs — flag them.
    const seenStanzas = new Set<string>();
    let seenKeysInStanza = new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('[') && line.endsWith(']')) {
        currentStanzaName = line.slice(1, -1);
        seenKeysInStanza = new Set<string>();
        if (seenStanzas.has(currentStanzaName)) {
          markers.push({
            severity: monacoRef.current.MarkerSeverity.Warning,
            message: `Duplicate stanza [${currentStanzaName}] — settings will be merged, later values win.`,
            startLineNumber: i + 1,
            startColumn: 1,
            endColumn: line.length + 1,
          });
        }
        seenStanzas.add(currentStanzaName);
        // Don't flag unknown stanzas for conf files with dynamic stanza names
        // (e.g., props.conf allows arbitrary sourcetype names, indexes.conf allows index names)
        const hasDynamicStanzas = spec.stanzas.some((s) => s.matchType === 'regex');
        if (!hasDynamicStanzas) {
          const isValidStanza = spec.stanzas.some((s) => {
            if (s.matchType === 'exact') return s.name === currentStanzaName;
            if (s.matchType === 'regex' && s.pattern) return s.pattern.test(currentStanzaName!);
            return false;
          });
          if (!isValidStanza) {
            markers.push({
              severity: monacoRef.current.MarkerSeverity.Warning,
              message: `Unknown stanza: [${currentStanzaName}]`,
              startLineNumber: i + 1,
              startColumn: 1,
              endColumn: line.length + 1,
            });
          }
        }
        continue;
      }
      if (line.includes('=')) {
        const [key] = line.split('=');
        const keyName = key.trim();

        if (seenKeysInStanza.has(keyName)) {
          markers.push({
            severity: monacoRef.current.MarkerSeverity.Warning,
            message: `Duplicate key '${keyName}' in stanza [${currentStanzaName}] — the last value wins.`,
            startLineNumber: i + 1,
            startColumn: 1,
            endColumn: key.length + 1,
          });
        }
        seenKeysInStanza.add(keyName);

        // Skip keys that contain dynamic portions like EXTRACT-<class>, TRANSFORMS-<class>, etc.
        const baseKeyName = keyName.replace(/-[^\s]+$/, '');
        const isDynamicKey = keyName !== baseKeyName;

        // Find the matching stanza spec
        const stanzaSpec = spec.stanzas.find((s) => {
          if (s.matchType === 'exact') return s.name === currentStanzaName;
          if (s.matchType === 'regex' && s.pattern) return s.pattern.test(currentStanzaName!);
          return false;
        });

        // Also check default stanza params
        const defaultStanza = spec.stanzas.find((s) => s.name === 'default');

        if (stanzaSpec || defaultStanza) {
          const paramInStanza = stanzaSpec?.params.get(keyName);
          const paramInDefault = defaultStanza?.params.get(keyName);
          // For dynamic keys like EXTRACT-myextraction, check if the base form exists
          const dynamicParamInStanza = isDynamicKey
            ? stanzaSpec?.params.get(`${baseKeyName}-<class>`) ||
              stanzaSpec?.params.get(`${baseKeyName}-<name>`) ||
              stanzaSpec?.params.get(`${baseKeyName}-<fieldname>`)
            : null;
          const dynamicParamInDefault = isDynamicKey
            ? defaultStanza?.params.get(`${baseKeyName}-<class>`) ||
              defaultStanza?.params.get(`${baseKeyName}-<name>`) ||
              defaultStanza?.params.get(`${baseKeyName}-<fieldname>`)
            : null;
          // Also check all known params globally as a final fallback
          const isKnownGlobally =
            allKnownParams.has(keyName) ||
            (isDynamicKey && [...allKnownParams].some((p) => p.startsWith(baseKeyName + '-')));

          if (
            !paramInStanza &&
            !paramInDefault &&
            !dynamicParamInStanza &&
            !dynamicParamInDefault &&
            !isKnownGlobally
          ) {
            markers.push({
              severity: monacoRef.current.MarkerSeverity.Warning,
              message: `Unknown key '${keyName}' in stanza [${currentStanzaName}]`,
              startLineNumber: i + 1,
              startColumn: 1,
              endColumn: key.length + 1,
            });
          }
        }
      }
    }
    monacoRef.current.editor.setModelMarkers(model, 'splunk-conf', markers);
  }, [selectedPath, displayContent]);

  // Live Python syntax checking: debounce edits, then parse server-side with
  // ast.parse (pure parse, nothing executed; no LLM involved). Squiggles the
  // SyntaxError position like a real IDE.
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;
    const isPython = Boolean(selectedPath?.endsWith('.py'));
    const model = editorRef.current.getModel();
    if (!isPython) {
      // Leaving a .py file: clear stale markers from the shared model.
      if (model) monacoRef.current.editor.setModelMarkers(model, 'python-syntax', []);
      return;
    }
    const code = displayContent || '';
    const timer = setTimeout(() => {
      fetch('/api/lint/python', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      })
        .then((r) => r.json())
        .then((d) => {
          // Ignore stale responses after the user switched files.
          if (selectedPathRef.current !== selectedPath) return;
          const liveModel = editorRef.current?.getModel();
          if (!liveModel || !monacoRef.current) return;
          const markers = d.ok
            ? []
            : [
                {
                  severity: monacoRef.current.MarkerSeverity.Error,
                  message: `SyntaxError: ${d.msg}`,
                  startLineNumber: d.line ?? 1,
                  startColumn: d.col ?? 1,
                  endLineNumber: d.endLine ?? d.line ?? 1,
                  endColumn: d.endCol ?? (d.col ?? 1) + 1,
                },
              ];
          monacoRef.current.editor.setModelMarkers(liveModel, 'python-syntax', markers);
        })
        .catch(() => {
          // Server unavailable — no diagnostics, never block editing.
        });
    }, 600);
    return () => clearTimeout(timer);
  }, [selectedPath, displayContent]);

  // Auto-expand all directories on mount
  useEffect(() => {
    const allDirs = new Set<string>(['/']);
    const traverse = (node: VFSNode) => {
      if (node.type === 'directory') {
        allDirs.add(node.path);
        for (const child of (node as VFSDirectory).children.values()) traverse(child);
      }
    };
    traverse(vfs.getRoot());
    setExpandedDirs(allDirs);
  }, [vfs]);

  const refreshTree = useCallback(() => forceUpdate({}), []);

  const getLanguage = (path: string): string => {
    const ext = path.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      py: 'python',
      js: 'javascript',
      ts: 'typescript',
      json: 'json',
      xml: 'xml',
      conf: 'splunk-conf',
      meta: 'splunk-conf',
      manifest: 'json',
      md: 'markdown',
      txt: 'plaintext',
      html: 'html',
      css: 'css',
      sh: 'shell',
      bash: 'shell',
    };
    return map[ext || ''] || 'plaintext';
  };

  const isImage = (path: string): boolean => {
    const ext = path.split('.').pop()?.toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico'].includes(ext || '');
  };

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleFileSelect = (path: string) => {
    if (hasUnsavedChanges && !confirm('You have unsaved changes. Discard them?')) return;
    setSelectedPath(path);
    setEditedContent(null);
    setHasUnsavedChanges(false);
  };

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined) {
      setEditedContent(value);
      setHasUnsavedChanges(value !== selectedContent);
    }
  };

  const handleSave = () => {
    if (selectedPath && editedContent !== null) {
      vfs.writeFile(selectedPath, editedContent);
      setHasUnsavedChanges(false);
      refreshTree();
    }
  };

  const handleContextMenu = (e: React.MouseEvent, path: string, type: 'file' | 'directory') => {
    e.preventDefault();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      targetPath: path,
      targetType: type,
    });
  };

  const closeContextMenu = () => setContextMenu((prev) => ({ ...prev, visible: false }));

  const handleNewFile = (parentPath: string) => {
    closeContextMenu();
    setNewItemModal({ visible: true, type: 'file', parentPath });
    setNewItemName('');
  };

  const handleNewFolder = (parentPath: string) => {
    closeContextMenu();
    setNewItemModal({ visible: true, type: 'folder', parentPath });
    setNewItemName('');
  };

  const handleCreateItem = () => {
    if (!newItemName.trim()) return;
    const parentPath = newItemModal.parentPath === '/' ? '' : newItemModal.parentPath;
    const newPath = `${parentPath}/${newItemName}`;
    if (newItemModal.type === 'file') {
      vfs.writeFile(newPath, '');
      setSelectedPath(newPath);
      setEditedContent('');
      setHasUnsavedChanges(false);
    } else {
      vfs.writeFile(`${newPath}/.gitkeep`, '');
    }
    setExpandedDirs((prev) => new Set([...prev, newItemModal.parentPath]));
    setNewItemModal({ visible: false, type: 'file', parentPath: '' });
    refreshTree();
  };

  const handleDelete = (path: string) => {
    closeContextMenu();
    if (confirm(`Are you sure you want to delete "${path}"?`)) {
      vfs.delete(path);
      if (selectedPath === path) {
        setSelectedPath(null);
        setEditedContent(null);
        setHasUnsavedChanges(false);
      }
      refreshTree();
    }
  };

  const handleRename = (path: string, currentName: string) => {
    closeContextMenu();
    setRenameModal({ visible: true, path, currentName });
    setRenameName(currentName);
  };

  const handleRenameSubmit = () => {
    if (!renameName.trim() || renameName === renameModal.currentName) {
      setRenameModal({ visible: false, path: '', currentName: '' });
      return;
    }
    const oldPath = renameModal.path;
    const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/')) || '/';
    const newPath = parentPath === '/' ? `/${renameName}` : `${parentPath}/${renameName}`;
    const content = vfs.readFile(oldPath);
    if (content !== null) {
      vfs.delete(oldPath);
      vfs.writeFile(newPath, content);
      if (selectedPath === oldPath) setSelectedPath(newPath);
    }
    setRenameModal({ visible: false, path: '', currentName: '' });
    refreshTree();
  };

  const handleDuplicate = (path: string) => {
    closeContextMenu();
    const content = vfs.readFile(path);
    if (content !== null) {
      const ext = path.includes('.') ? path.substring(path.lastIndexOf('.')) : '';
      const baseName = path.includes('.') ? path.substring(0, path.lastIndexOf('.')) : path;
      vfs.writeFile(`${baseName}_copy${ext}`, content);
      refreshTree();
    }
  };

  const handleOpenComponentsModal = () => {
    if (wizardState) {
      setTempComponentsConfig(JSON.parse(JSON.stringify(wizardState.components)));
      setShowComponentsModal(true);
    }
  };

  const handleSaveComponents = () => {
    if (wizardState && onUpdateConfig && tempComponentsConfig) {
      onUpdateConfig({ ...wizardState, components: tempComponentsConfig });
      setShowComponentsModal(false);
      setTempComponentsConfig(null);
    }
  };

  const getFileIcon = (filename: string): string => {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'py':
        return '\u{1F40D}';
      case 'json':
        return '{}';
      case 'xml':
        return '\u{1F4C4}';
      case 'conf':
      case 'meta':
        return '\u2699\uFE0F';
      case 'txt':
      case 'md':
        return '\u{1F4DD}';
      case 'sh':
      case 'bash':
        return '\u{1F4BB}';
      default:
        return '\u{1F4C4}';
    }
  };

  const renderNode = (node: VFSNode, depth: number = 0): React.ReactNode => {
    // Check visibility first
    if (!isVisible(node, developerMode)) return null;

    if (node.type === 'file') {
      const isSelected = selectedPath === node.path;
      return (
        <TreeItem
          key={node.path}
          $depth={depth}
          $selected={isSelected}
          onClick={() => handleFileSelect(node.path)}
          onContextMenu={(e) => handleContextMenu(e, node.path, 'file')}
          title={
            (node as VFSFile).source === 'modified'
              ? 'Modified from original'
              : (node as VFSFile).source === 'user'
                ? 'User created'
                : 'Generated file'
          }
        >
          {getFileIcon(node.name)} {node.name}
          {(node as VFSFile).source === 'modified' && (
            <Badge
              label="M"
              style={{
                backgroundColor: '#F58220',
                color: '#fff',
                marginLeft: 'auto',
                fontSize: '10px',
                height: '16px',
                lineHeight: '16px',
                minWidth: '16px',
                padding: '0 4px',
              }}
            />
          )}
          {(node as VFSFile).source === 'user' && (
            <Badge
              label="U"
              style={{
                backgroundColor: '#006D9C',
                color: '#fff',
                marginLeft: 'auto',
                fontSize: '10px',
                height: '16px',
                lineHeight: '16px',
                minWidth: '16px',
                padding: '0 4px',
              }}
            />
          )}
          {isSelected && hasUnsavedChanges && (
            <Badge
              label="●"
              style={{
                backgroundColor: 'transparent',
                color: '#F58220',
                marginLeft:
                  (node as VFSFile).source === 'modified' || (node as VFSFile).source === 'user'
                    ? '4px'
                    : 'auto',
                fontSize: '12px',
                padding: 0,
              }}
            />
          )}
        </TreeItem>
      );
    }

    const isExpanded = expandedDirs.has(node.path);
    // Filter children for rendering to ensure directories are rendered only if they have visible content
    // But renderNode handles visibility check at the top.
    const children = Array.from((node as VFSDirectory).children.values())
      .filter((child) => isVisible(child, developerMode))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    if (children.length === 0 && node.path !== '/' && !['lib', 'bin'].includes(node.name)) {
      // Double check: if empty but visible (e.g. empty lib), we show it.
      // isVisible allows lib/bin.
    }

    return (
      <div key={node.path}>
        {node.path !== '/' && (
          <TreeItem
            $depth={depth}
            $isDir
            onClick={() => toggleDir(node.path)}
            onContextMenu={(e) => handleContextMenu(e, node.path, 'directory')}
          >
            {isExpanded ? '\u25BC' : '\u25B6'} {node.name}/
          </TreeItem>
        )}
        {isExpanded &&
          children.map((child) => renderNode(child, node.path === '/' ? depth : depth + 1))}
      </div>
    );
  };

  return (
    <div
      onClick={closeContextMenu}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
    >
      <Message type="success" style={{ flexShrink: 0, marginBottom: 16 }}>
        App generated successfully. Edit files below or download as ZIP.
      </Message>

      <Toolbar>
        <Button
          appearance="primary"
          onClick={handleSave}
          disabled={!hasUnsavedChanges}
          label={hasUnsavedChanges ? 'Save \u25CF' : 'Save'}
        />
        <Button appearance="default" onClick={() => handleNewFile('/')} label="New File" />
        <Button appearance="default" onClick={() => handleNewFolder('/')} label="New Folder" />
        <ToolbarSpacer />
        <Switch
          selected={aiComplete}
          onClick={() => {
            const next = !aiComplete;
            setInlineEnabled(next);
            setAiComplete(next);
          }}
          appearance="toggle"
          title="Ghost-text AI completion in the editor (Tab to accept)"
        >
          ✨ AI complete
        </Switch>
        {aiComplete && (
          <Select
            value={completeModel}
            onChange={(_e: unknown, { value }: { value: string | number | boolean }) => {
              const m = String(value);
              setCompleteModel(m);
              try {
                localStorage.setItem(COMPLETION_MODEL_STORAGE, m);
              } catch {
                /* ignore */
              }
            }}
            style={{ minWidth: 200 }}
          >
            {COMPLETION_MODEL_CHOICES.map((m) => (
              <Select.Option key={m.id} label={m.label} value={m.id} />
            ))}
          </Select>
        )}
        {wizardState && onUpdateConfig && (
          <Button
            appearance="primary"
            onClick={handleOpenComponentsModal}
            label="Manage Components"
          />
        )}
      </Toolbar>

      <BrowserContainer>
        <FileTree>{renderNode(vfs.getRoot())}</FileTree>
        <FileContent>
          {selectedPath ? (
            isImage(selectedPath) ? (
              <ImagePreview>
                <ImageContainer>
                  <img
                    src={`data:image/${selectedPath.split('.').pop()};base64,${displayContent}`}
                    alt={selectedPath}
                  />
                </ImageContainer>
                <p style={{ marginTop: 16, color: '#9b9ea3', fontFamily: 'monospace' }}>
                  {selectedPath}
                </p>
              </ImagePreview>
            ) : (
              <Editor
                height="100%"
                language={getLanguage(selectedPath)}
                value={displayContent || ''}
                onChange={handleEditorChange}
                onMount={handleEditorDidMount}
                theme="vs-dark"
                options={{
                  minimap: { enabled: false },
                  fontSize: 14,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  automaticLayout: true,
                  tabSize: 2,
                  suggestLineHeight: 50,
                  suggestFontSize: 14,
                  suggest: { showIcons: true, insertMode: 'replace', preview: true },
                  fixedOverflowWidgets: true,
                  // IDE feel: accept suggestions with Tab, suggest while typing
                  // (not only on trigger characters), keep snippets visible.
                  tabCompletion: 'on',
                  // Ghost-text AI completion (accept with Tab). The provider self-gates on
                  // the opt-in flag, so leaving this enabled is free when AI complete is off.
                  inlineSuggest: { enabled: true },
                  quickSuggestions: { other: true, comments: false, strings: true },
                  suggestOnTriggerCharacters: true,
                  acceptSuggestionOnEnter: 'on',
                  snippetSuggestions: 'inline',
                  parameterHints: { enabled: true },
                  bracketPairColorization: { enabled: true },
                  folding: true,
                  formatOnPaste: true,
                }}
              />
            )
          ) : (
            <EmptyState>Select a file to view and edit its contents</EmptyState>
          )}
        </FileContent>
      </BrowserContainer>

      {/* Context Menu */}
      {contextMenu.visible && (
        <ContextMenuOverlay
          $x={contextMenu.x}
          $y={contextMenu.y}
          onClick={(e) => e.stopPropagation()}
        >
          <Menu>
            {contextMenu.targetType === 'directory' && (
              <>
                <Menu.Item onClick={() => handleNewFile(contextMenu.targetPath)}>
                  New File
                </Menu.Item>
                <Menu.Item onClick={() => handleNewFolder(contextMenu.targetPath)}>
                  New Folder
                </Menu.Item>
                <Menu.Divider />
              </>
            )}
            {contextMenu.targetType === 'file' && (
              <Menu.Item onClick={() => handleDuplicate(contextMenu.targetPath)}>
                Duplicate
              </Menu.Item>
            )}
            <Menu.Item
              onClick={() => {
                const name = contextMenu.targetPath.split('/').pop() || '';
                handleRename(contextMenu.targetPath, name);
              }}
            >
              Rename
            </Menu.Item>
            <Menu.Item
              onClick={() => handleDelete(contextMenu.targetPath)}
              style={{ color: '#D32F2F' }}
            >
              Delete
            </Menu.Item>
          </Menu>
        </ContextMenuOverlay>
      )}

      {/* New Item Modal */}
      <Modal
        open={newItemModal.visible}
        onRequestClose={() => setNewItemModal({ visible: false, type: 'file', parentPath: '' })}
        returnFocus={modalReturnRef as React.MutableRefObject<HTMLElement>}
      >
        <Modal.Header title={`New ${newItemModal.type === 'file' ? 'File' : 'Folder'}`} />
        <Modal.Body>
          <Text
            value={newItemName}
            onChange={(_e: unknown, { value }: { value: string }) => setNewItemName(value)}
            autoFocus
          />
        </Modal.Body>
        <Modal.Footer>
          <Button
            appearance="default"
            onClick={() => setNewItemModal({ visible: false, type: 'file', parentPath: '' })}
            label="Cancel"
          />
          <Button appearance="primary" onClick={handleCreateItem} label="Create" />
        </Modal.Footer>
      </Modal>

      {/* Rename Modal */}
      <Modal
        open={renameModal.visible}
        onRequestClose={() => setRenameModal({ visible: false, path: '', currentName: '' })}
        returnFocus={modalReturnRef as React.MutableRefObject<HTMLElement>}
      >
        <Modal.Header title="Rename" />
        <Modal.Body>
          <Text
            value={renameName}
            onChange={(_e: unknown, { value }: { value: string }) => setRenameName(value)}
            autoFocus
          />
        </Modal.Body>
        <Modal.Footer>
          <Button
            appearance="default"
            onClick={() => setRenameModal({ visible: false, path: '', currentName: '' })}
            label="Cancel"
          />
          <Button appearance="primary" onClick={handleRenameSubmit} label="Rename" />
        </Modal.Footer>
      </Modal>

      {/* Manage Components Modal */}
      <Modal
        open={showComponentsModal}
        onRequestClose={() => setShowComponentsModal(false)}
        returnFocus={modalReturnRef as React.MutableRefObject<HTMLElement>}
        style={{ width: '90%', maxWidth: 1000 }}
      >
        <Modal.Header title="Manage Components" />
        <Modal.Body>
          {tempComponentsConfig && (
            <ComponentsStep config={tempComponentsConfig} onChange={setTempComponentsConfig} />
          )}
        </Modal.Body>
        <Modal.Footer>
          <Message type="warning" style={{ flex: 1 }}>
            Changes will regenerate configuration files. Custom edits to generated files may be
            lost.
          </Message>
          <Button
            appearance="default"
            onClick={() => setShowComponentsModal(false)}
            label="Cancel"
          />
          <Button
            appearance="primary"
            onClick={handleSaveComponents}
            label="Save &amp; Regenerate"
          />
        </Modal.Footer>
      </Modal>
    </div>
  );
}
