import { useState, useCallback, useEffect, useRef } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import type { VirtualFileSystem } from '../lib/vfs';
import type { VFSNode, VFSDirectory } from '../types/vfs';
import { SpecParser } from '../lib/specParser';
import { SPLUNK_SPECS } from '../lib/splunkSpecs';
import uccSchema from '../lib/uccSchema.json';
import type { WizardState } from '../types/app';
import { ComponentsStep } from './wizard/ComponentsStep';
import type { ComponentsConfig } from '../types/components';

interface FileBrowserProps {
  vfs: VirtualFileSystem;
  wizardState?: WizardState;
  onUpdateConfig?: (newState: WizardState) => void;
}

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  targetPath: string;
  targetType: 'file' | 'directory';
}

export function FileBrowser({ vfs, wizardState, onUpdateConfig }: FileBrowserProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(['/']));
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
  }>({ visible: false, type: 'file', parentPath: '' });
  const [newItemName, setNewItemName] = useState('');
  const [renameModal, setRenameModal] = useState<{
    visible: boolean;
    path: string;
    currentName: string;
  }>({ visible: false, path: '', currentName: '' });
  const [renameName, setRenameName] = useState('');
  const [, forceUpdate] = useState({});

  // Components Management State
  const [showComponentsModal, setShowComponentsModal] = useState(false);
  const [tempComponentsConfig, setTempComponentsConfig] = useState<ComponentsConfig | null>(null);

  const selectedContent = selectedPath ? vfs.readFile(selectedPath) : null;
  const displayContent = hasUnsavedChanges ? editedContent : selectedContent;

  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const specParser = useRef(new SpecParser());

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Configure JSON Validation for globalConfig.json
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      schemas: [{
        uri: 'https://raw.githubusercontent.com/splunk/addonfactory-ucc-generator/refs/heads/develop/splunk_add_on_ucc_framework/schema/schema.json',
        fileMatch: ['globalConfig.json'],
        schema: uccSchema
      }]
    });

    // Register Splunk Conf Language
    monaco.languages.register({ id: 'splunk-conf' });

    // Register Completion Provider
    monaco.languages.registerCompletionItemProvider('splunk-conf', {
      triggerCharacters: ['[', '=', ' '],
      provideCompletionItems: (model: any, position: any) => {
        const textUntilPosition = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });

        const filename = selectedPath?.split('/').pop()!;
        const specContent = SPLUNK_SPECS[filename];
        if (!specContent) return { suggestions: [] };

        const spec = new SpecParser().parse(filename + '.spec', specContent);
        const suggestions: any[] = [];

        // 1. Stanza Completion (start of line or after [)
        if (textUntilPosition.trim() === '[' || textUntilPosition.trim() === '') {
          spec.stanzas.forEach(s => {
            suggestions.push({
              label: `[${s.name}]`,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: s.name.includes('<') ? s.name : `[${s.name}]`,
              documentation: s.description,
              range: {
                startLineNumber: position.lineNumber,
                startColumn: textUntilPosition.indexOf('[') + 1 || 1,
                endLineNumber: position.lineNumber,
                endColumn: position.column
              }
            });
          });
        }

        // 2. Key Completion (inside a stanza)
        // Find current stanza
        let currentStanzaName: string | null = null;
        for (let i = position.lineNumber - 1; i >= 1; i--) {
          const line = model.getLineContent(i).trim();
          if (line.startsWith('[') && line.endsWith(']')) {
            currentStanzaName = line.slice(1, -1);
            break;
          }
        }

        if (currentStanzaName && !textUntilPosition.includes('=')) {
          const stanzaSpec = spec.stanzas.find(s => {
            if (s.matchType === 'exact') return s.name === currentStanzaName;
            if (s.matchType === 'regex' && s.pattern) return s.pattern.test(currentStanzaName!);
            return false;
          });

          if (stanzaSpec) {
            stanzaSpec.params.forEach(p => {
              suggestions.push({
                label: p.name,
                kind: monaco.languages.CompletionItemKind.Property,
                insertText: `${p.name} = `,
                documentation: p.description,
              });
            });
          }
        }

        // 3. Value Completion (after =)
        if (textUntilPosition.includes('=')) {
          // Simple boolean/enum suggestions
          // In a real implementation, we'd parse the type from spec (e.g. <boolean>, <integer>)
          suggestions.push(
            { label: 'true', kind: monaco.languages.CompletionItemKind.Value, insertText: 'true' },
            { label: 'false', kind: monaco.languages.CompletionItemKind.Value, insertText: 'false' },
            { label: 'enabled', kind: monaco.languages.CompletionItemKind.Value, insertText: 'enabled' },
            { label: 'disabled', kind: monaco.languages.CompletionItemKind.Value, insertText: 'disabled' }
          );
        }

        return { suggestions };
      }
    });
  };

  // Validation Effect
  useEffect(() => {
    if (!selectedPath || !selectedPath.endsWith('.conf') || !editorRef.current || !monacoRef.current) {
      return;
    }

    const filename = selectedPath.split('/').pop()!;
    const specContent = SPLUNK_SPECS[filename];

    if (!specContent) return;

    const spec = specParser.current.parse(filename + '.spec', specContent);
    const model = editorRef.current.getModel();
    const content = displayContent || '';
    const markers: any[] = [];

    const lines = content.split('\n');
    let currentStanzaName: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;

      // Validate Stanza
      if (line.startsWith('[') && line.endsWith(']')) {
        currentStanzaName = line.slice(1, -1);
        const isValidStanza = spec.stanzas.some(s => {
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
        continue;
      }

      // Validate Key
      if (line.includes('=')) {
        const [key] = line.split('=');
        const keyName = key.trim();

        // Find the spec definition for the current stanza
        const stanzaSpec = spec.stanzas.find(s => {
          if (s.matchType === 'exact') return s.name === currentStanzaName;
          if (s.matchType === 'regex' && s.pattern) return s.pattern.test(currentStanzaName!);
          return false;
        });

        if (stanzaSpec) {
          // Check if key exists in spec params
          const paramSpec = stanzaSpec.params.get(keyName);
          if (!paramSpec) {
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

  // Auto-expand all directories on mount
  useEffect(() => {
    const allDirs = new Set<string>(['/']);
    const traverse = (node: VFSNode) => {
      if (node.type === 'directory') {
        allDirs.add(node.path);
        for (const child of (node as VFSDirectory).children.values()) {
          traverse(child);
        }
      }
    };
    traverse(vfs.getRoot());
    setExpandedDirs(allDirs);
  }, [vfs]);

  const refreshTree = useCallback(() => {
    forceUpdate({});
  }, []);

  const getLanguage = (path: string): string => {
    const ext = path.split('.').pop()?.toLowerCase();
    const languageMap: Record<string, string> = {
      py: 'python',
      js: 'javascript',
      ts: 'typescript',
      json: 'json',
      xml: 'xml',
      conf: 'splunk-conf',
      meta: 'splunk-conf',
      manifest: 'json', // Treat app.manifest as JSON
      md: 'markdown',
      txt: 'plaintext',
      html: 'html',
      css: 'css',
      sh: 'shell',
      bash: 'shell',
    };
    return languageMap[ext || ''] || 'plaintext';
  };

  const isImage = (path: string): boolean => {
    const ext = path.split('.').pop()?.toLowerCase();
    return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico'].includes(ext || '');
  };

  const toggleDir = (path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleFileSelect = (path: string) => {
    if (hasUnsavedChanges) {
      if (!confirm('You have unsaved changes. Discard them?')) {
        return;
      }
    }
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

  const closeContextMenu = () => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };

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
      // Create folder by adding a placeholder file
      vfs.writeFile(`${newPath}/.gitkeep`, '');
    }

    // Expand parent directory
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

    // Read content, delete old, write new
    const content = vfs.readFile(oldPath);
    if (content !== null) {
      vfs.delete(oldPath);
      vfs.writeFile(newPath, content);
      if (selectedPath === oldPath) {
        setSelectedPath(newPath);
      }
    }

    setRenameModal({ visible: false, path: '', currentName: '' });
    refreshTree();
  };

  const handleDuplicate = (path: string) => {
    closeContextMenu();
    const content = vfs.readFile(path);
    if (content !== null) {
      const ext = path.includes('.') ? path.substring(path.lastIndexOf('.')) : '';
      const baseName = path.includes('.')
        ? path.substring(0, path.lastIndexOf('.'))
        : path;
      const newPath = `${baseName}_copy${ext}`;
      vfs.writeFile(newPath, content);
      refreshTree();
    }
  };

  // --- Components Management Handlers ---
  const handleOpenComponentsModal = () => {
    if (wizardState) {
      setTempComponentsConfig(JSON.parse(JSON.stringify(wizardState.components)));
      setShowComponentsModal(true);
    }
  };

  const handleSaveComponents = () => {
    if (wizardState && onUpdateConfig && tempComponentsConfig) {
      onUpdateConfig({
        ...wizardState,
        components: tempComponentsConfig
      });
      setShowComponentsModal(false);
      setTempComponentsConfig(null);
    }
  };

  const renderNode = (node: VFSNode, depth: number = 0): React.ReactNode => {
    const indent = depth * 16;

    if (node.type === 'file') {
      const isSelected = selectedPath === node.path;
      const isUnsaved = isSelected && hasUnsavedChanges;

      return (
        <div
          key={node.path}
          className={`file-tree-item ${isSelected ? 'selected' : ''}`}
          style={{ paddingLeft: `${indent + 8}px` }}
          onClick={() => handleFileSelect(node.path)}
          onContextMenu={(e) => handleContextMenu(e, node.path, 'file')}
        >
          {getFileIcon(node.name)} {node.name}
          {isUnsaved && <span className="unsaved-indicator">●</span>}
        </div>
      );
    }

    const isExpanded = expandedDirs.has(node.path);
    const children = Array.from((node as VFSDirectory).children.values()).sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return (
      <div key={node.path}>
        {node.path !== '/' && (
          <div
            className="file-tree-item directory"
            style={{ paddingLeft: `${indent + 8}px` }}
            onClick={() => toggleDir(node.path)}
            onContextMenu={(e) => handleContextMenu(e, node.path, 'directory')}
          >
            {isExpanded ? '▼' : '▶'} {node.name}/
          </div>
        )}
        {isExpanded && children.map((child) => renderNode(child, node.path === '/' ? depth : depth + 1))}
      </div>
    );
  };

  return (
    <div onClick={closeContextMenu}>
      <div className="success-message">
        App generated successfully. Edit files below or download as ZIP.
      </div>

      <div className="editor-toolbar">
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={!hasUnsavedChanges}
        >
          Save {hasUnsavedChanges && '●'}
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => handleNewFile('/')}
        >
          New File
        </button>
        <button
          className="btn btn-secondary"
          onClick={() => handleNewFolder('/')}
        >
          New Folder
        </button>
        <div style={{ flex: 1 }} />
        {wizardState && onUpdateConfig && (
          <button
            className="btn btn-primary"
            onClick={handleOpenComponentsModal}
            title="Edit modular inputs, alerts, and other components"
          >
            Manage Components
          </button>
        )}
      </div>

      <div className="file-browser">
        <div className="file-tree">
          {renderNode(vfs.getRoot())}
        </div>
        <div className="file-content">
          {selectedPath ? (
            isImage(selectedPath) ? (
              <div className="image-preview">
                <div className="image-container">
                  <img
                    src={`data:image/${selectedPath.split('.').pop()};base64,${displayContent}`}
                    alt={selectedPath}
                  />
                </div>
                <div className="image-info">
                  {selectedPath}
                </div>
              </div>
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
                suggestLineHeight: 50, // Increased further for better visibility
                suggestFontSize: 14,
                suggest: {
                  showIcons: true,
                  insertMode: 'replace',
                },
                fixedOverflowWidgets: true // This helps with widget clipping
              }}
            />
            )
          ) : (
            <div className="no-file-selected">
              Select a file to view and edit its contents
            </div>
          )}
        </div>
      </div>

      {/* Context Menu */}
      {contextMenu.visible && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.targetType === 'directory' && (
            <>
              <button onClick={() => handleNewFile(contextMenu.targetPath)}>New File</button>
              <button onClick={() => handleNewFolder(contextMenu.targetPath)}>New Folder</button>
              <div className="context-menu-divider" />
            </>
          )}
          {contextMenu.targetType === 'file' && (
            <>
              <button onClick={() => handleDuplicate(contextMenu.targetPath)}>Duplicate</button>
            </>
          )}
          <button onClick={() => {
            const name = contextMenu.targetPath.split('/').pop() || '';
            handleRename(contextMenu.targetPath, name);
          }}>Rename</button>
          <button onClick={() => handleDelete(contextMenu.targetPath)} className="danger">Delete</button>
        </div>
      )}

      {/* New Item Modal */}
      {newItemModal.visible && (
        <div className="modal-overlay" onClick={() => setNewItemModal({ visible: false, type: 'file', parentPath: '' })}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>New {newItemModal.type === 'file' ? 'File' : 'Folder'}</h3>
            <input
              type="text"
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              placeholder={newItemModal.type === 'file' ? 'filename.py' : 'folder_name'}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleCreateItem()}
            />
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setNewItemModal({ visible: false, type: 'file', parentPath: '' })}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleCreateItem}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {renameModal.visible && (
        <div className="modal-overlay" onClick={() => setRenameModal({ visible: false, path: '', currentName: '' })}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Rename</h3>
            <input
              type="text"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && handleRenameSubmit()}
            />
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setRenameModal({ visible: false, path: '', currentName: '' })}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleRenameSubmit}>
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manage Components Modal */}
      {showComponentsModal && tempComponentsConfig && (
        <div className="modal-overlay large" onClick={() => setShowComponentsModal(false)}>
          <div className="modal large-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Manage Components</h3>
              <button className="btn-icon" onClick={() => setShowComponentsModal(false)}>✕</button>
            </div>
            
            <div className="modal-body-scroll">
              <ComponentsStep 
                config={tempComponentsConfig} 
                onChange={setTempComponentsConfig} 
              />
            </div>

            <div className="modal-footer">
              <div className="warning-text">
                Changes will regenerate configuration files. Custom edits to generated files may be lost.
              </div>
              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={() => setShowComponentsModal(false)}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={handleSaveComponents}>
                  Save & Regenerate
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .editor-toolbar {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 1rem;
          align-items: center;
        }
        .file-browser {
          display: flex;
          gap: 1rem;
          height: 600px;
        }
        .file-tree {
          width: 280px;
          background-color: var(--splunk-gray);
          border-radius: 4px;
          padding: 0.5rem;
          overflow-y: auto;
          font-size: 0.875rem;
        }
        .file-tree-item {
          padding: 0.35rem 0.5rem;
          cursor: pointer;
          border-radius: 4px;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          user-select: none;
        }
        .file-tree-item:hover {
          background-color: var(--splunk-dark);
        }
        .file-tree-item.selected {
          background-color: var(--splunk-green);
        }
        .file-tree-item.directory {
          color: var(--splunk-green);
        }
        .unsaved-indicator {
          color: #F58220;
          margin-left: auto;
        }
        .file-content {
          flex: 1;
          background-color: #1e1e1e;
          border-radius: 4px;
          overflow: hidden;
        }
        .no-file-selected {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--text-secondary);
        }
        .image-preview {
          height: 100%;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background-color: #1e1e1e;
          padding: 2rem;
        }
        .image-container {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          width: 100%;
        }
        .image-container img {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
          background-image: linear-gradient(45deg, #333 25%, transparent 25%),
                            linear-gradient(-45deg, #333 25%, transparent 25%),
                            linear-gradient(45deg, transparent 75%, #333 75%),
                            linear-gradient(-45deg, transparent 75%, #333 75%);
          background-size: 20px 20px;
          background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
          border: 1px solid var(--border-color);
        }
        .image-info {
          margin-top: 1rem;
          color: var(--text-secondary);
          font-family: monospace;
        }
        .context-menu {
          position: fixed;
          background-color: var(--splunk-gray);
          border: 1px solid var(--border-color);
          border-radius: 4px;
          padding: 0.25rem;
          z-index: 1000;
          min-width: 120px;
        }
        .context-menu button {
          display: block;
          width: 100%;
          padding: 0.5rem 0.75rem;
          text-align: left;
          background: none;
          border: none;
          color: var(--text-primary);
          cursor: pointer;
          border-radius: 4px;
        }
        .context-menu button:hover {
          background-color: var(--splunk-dark);
        }
        .context-menu button.danger {
          color: #D32F2F;
        }
        .context-menu-divider {
          height: 1px;
          background-color: var(--border-color);
          margin: 0.25rem 0;
        }
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: rgba(0, 0, 0, 0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1001;
        }
        .modal {
          background-color: var(--splunk-gray);
          border-radius: 8px;
          padding: 1.5rem;
          min-width: 300px;
        }
        .large-modal-content {
          width: 90%;
          max-width: 1000px;
          height: 85vh;
          display: flex;
          flex-direction: column;
          padding: 0; /* Reset padding for flex layout */
        }
        .modal-header {
          padding: 1.5rem;
          border-bottom: 1px solid var(--border-color);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .modal-header h3 {
          margin: 0;
        }
        .modal-body-scroll {
          flex: 1;
          overflow-y: auto;
          padding: 1.5rem;
        }
        .modal-footer {
          padding: 1.5rem;
          border-top: 1px solid var(--border-color);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .warning-text {
          color: #F58220;
          font-size: 0.9rem;
        }
        .modal h3 {
          margin-bottom: 1rem;
        }
        .modal input {
          width: 100%;
          padding: 0.75rem;
          border: 1px solid var(--border-color);
          border-radius: 4px;
          background-color: var(--splunk-dark);
          color: var(--text-primary);
          font-size: 1rem;
          margin-bottom: 1rem;
        }
        .modal-actions {
          display: flex;
          gap: 0.5rem;
          justify-content: flex-end;
        }
        .btn-icon {
          background: none;
          border: none;
          color: var(--text-secondary);
          font-size: 1.25rem;
          cursor: pointer;
          padding: 0.25rem;
        }
        .btn-icon:hover {
          color: white;
        }
      `}</style>
    </div>
  );
}

function getFileIcon(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'py':
      return '🐍';
    case 'json':
      return '{}';
    case 'xml':
      return '📄';
    case 'conf':
    case 'meta':
      return '⚙️';
    case 'txt':
    case 'md':
      return '📝';
    case 'sh':
    case 'bash':
      return '💻';
    default:
      return '📄';
  }
}
