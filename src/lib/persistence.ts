/**
 * State persistence utilities
 * Saves and restores app state to/from localStorage
 */

import type { WizardState } from '../types/app';
import { DEFAULT_WIZARD_STATE } from '../types/app';

const STORAGE_KEY = 'splunk-app-builder-state';
const VFS_STORAGE_KEY = 'splunk-app-builder-vfs';

import type { GitHubSession } from '../types/github';

interface PersistedState {
  mode: 'welcome' | 'wizard' | 'import' | 'files' | 'loop';
  wizardState: WizardState;
  appName: string;
  generated: boolean;
  developerMode?: boolean;
  gitHubSession?: GitHubSession;
  savedAt: string;
}

/**
 * Save app state to localStorage
 */
export function saveState(state: Omit<PersistedState, 'savedAt'>): void {
  try {
    const toSave: PersistedState = {
      ...state,
      // Remove non-serializable properties from wizardState
      wizardState: {
        ...state.wizardState,
        branding: {
          ...state.wizardState.branding,
          logoFile: null, // File objects can't be serialized
        },
      },
      savedAt: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch (error) {
    console.warn('Failed to save state to localStorage:', error);
  }
}

/**
 * Load app state from localStorage
 */
export function loadState(): PersistedState | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;

    const state = JSON.parse(saved) as PersistedState;

    // Validate the loaded state has required properties
    if (!state.wizardState || !state.mode) {
      return null;
    }

    // Merge with defaults to handle any missing properties from older versions
    return {
      ...state,
      developerMode: state.developerMode || false,
      // gitHubSession is optional, no default needed

      wizardState: {
        ...DEFAULT_WIZARD_STATE,
        ...state.wizardState,
        metadata: {
          ...DEFAULT_WIZARD_STATE.metadata,
          ...state.wizardState.metadata,
        },
        branding: {
          ...DEFAULT_WIZARD_STATE.branding,
          ...state.wizardState.branding,
        },
        components: {
          ...DEFAULT_WIZARD_STATE.components,
          ...state.wizardState.components,
        },
      },
    };
  } catch (error) {
    console.warn('Failed to load state from localStorage:', error);
    return null;
  }
}

/**
 * Clear saved state
 */
export function clearState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(VFS_STORAGE_KEY);
  } catch (error) {
    console.warn('Failed to clear state from localStorage:', error);
  }
}

/**
 * Save VFS contents to localStorage
 */
export function saveVFS(files: Array<{ path: string; content: string }>): void {
  try {
    localStorage.setItem(VFS_STORAGE_KEY, JSON.stringify(files));
  } catch (error) {
    console.warn('Failed to save VFS to localStorage:', error);
  }
}

/**
 * Load VFS contents from localStorage
 */
export function loadVFS(): Array<{ path: string; content: string }> | null {
  try {
    const saved = localStorage.getItem(VFS_STORAGE_KEY);
    if (!saved) return null;
    return JSON.parse(saved);
  } catch (error) {
    console.warn('Failed to load VFS from localStorage:', error);
    return null;
  }
}

/**
 * Check if there's saved state available
 */
export function hasSavedState(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

/**
 * Get the timestamp of the last save
 */
export function getLastSaveTime(): Date | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return null;
    const state = JSON.parse(saved) as PersistedState;
    return state.savedAt ? new Date(state.savedAt) : null;
  } catch {
    return null;
  }
}
