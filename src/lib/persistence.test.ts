import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  saveState,
  loadState,
  clearState,
  saveVFS,
  loadVFS,
  hasSavedState,
  getLastSaveTime,
} from './persistence';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

beforeEach(() => {
  vi.stubGlobal('localStorage', localStorageMock);
  localStorageMock.clear();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const minimalState = {
  mode: 'wizard' as const,
  wizardState: {
    currentStep: 0,
    metadata: {
      name: 'test_app',
      displayName: 'Test App',
      version: '1.0.0',
      author: 'Tester',
      email: 'tester@example.com',
      description: 'A test app',
      appId: 'test_app',
      licenseName: 'MIT',
      licenseUri: 'https://opensource.org/licenses/MIT',
    },
    branding: {
      logoFile: null,
      logoDataUrl: undefined,
      processedIcons: undefined,
      navBarColor: '#000000',
    },
    components: {
      inputs: [],
      commands: [],
      alertActions: [],
      accounts: [],
      restEndpoints: [],
      logging: { enabled: false, defaultLevel: 'INFO' as const },
      proxy: { enabled: false, proxyType: 'http' as const, host: '', port: '' },
      customTabs: [],
    },
  },
  appName: 'test_app',
  generated: false,
};

describe('saveState', () => {
  it('should save state to localStorage', () => {
    saveState(minimalState);
    expect(localStorageMock.setItem).toHaveBeenCalledWith(
      'splunk-app-builder-state',
      expect.any(String)
    );
  });

  it('should include savedAt timestamp', () => {
    saveState(minimalState);
    const saved = JSON.parse(localStorageMock.setItem.mock.calls[0][1]);
    expect(saved.savedAt).toBeDefined();
    expect(new Date(saved.savedAt).getTime()).not.toBeNaN();
  });

  it('should strip logoFile (non-serializable)', () => {
    saveState(minimalState);
    const saved = JSON.parse(localStorageMock.setItem.mock.calls[0][1]);
    expect(saved.wizardState.branding.logoFile).toBeNull();
  });

  it('should not throw when localStorage fails', () => {
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => saveState(minimalState)).not.toThrow();
  });
});

describe('loadState', () => {
  it('should return null when nothing saved', () => {
    expect(loadState()).toBeNull();
  });

  it('should return parsed state', () => {
    saveState(minimalState);
    const loaded = loadState();
    expect(loaded).not.toBeNull();
    expect(loaded!.appName).toBe('test_app');
  });

  it('should return null for corrupt JSON', () => {
    localStorageMock.getItem.mockReturnValueOnce('not-json');
    expect(loadState()).toBeNull();
  });

  it('should return null when wizardState is missing', () => {
    localStorageMock.getItem.mockReturnValueOnce(JSON.stringify({ mode: 'wizard' }));
    expect(loadState()).toBeNull();
  });

  it('should return null when mode is missing', () => {
    localStorageMock.getItem.mockReturnValueOnce(JSON.stringify({ wizardState: {} }));
    expect(loadState()).toBeNull();
  });

  it('should merge with defaults for missing properties', () => {
    saveState(minimalState);
    const loaded = loadState();
    expect(loaded).not.toBeNull();
    expect(loaded!.developerMode).toBe(false);
  });
});

describe('clearState', () => {
  it('should remove both storage keys', () => {
    saveState(minimalState);
    clearState();
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('splunk-app-builder-state');
    expect(localStorageMock.removeItem).toHaveBeenCalledWith('splunk-app-builder-vfs');
  });

  it('should not throw when localStorage fails', () => {
    localStorageMock.removeItem.mockImplementationOnce(() => {
      throw new Error('fail');
    });
    expect(() => clearState()).not.toThrow();
  });
});

describe('saveVFS / loadVFS', () => {
  const files = [
    { path: 'file1.txt', content: 'hello' },
    { path: 'file2.txt', content: 'world' },
  ];

  it('should round-trip VFS data', () => {
    saveVFS(files);
    const loaded = loadVFS();
    expect(loaded).toEqual(files);
  });

  it('should return null when no VFS saved', () => {
    expect(loadVFS()).toBeNull();
  });

  it('should return null for corrupt VFS JSON', () => {
    localStorageMock.getItem.mockReturnValueOnce('broken{');
    expect(loadVFS()).toBeNull();
  });
});

describe('hasSavedState', () => {
  it('should return false when nothing saved', () => {
    expect(hasSavedState()).toBe(false);
  });

  it('should return true after saving', () => {
    saveState(minimalState);
    expect(hasSavedState()).toBe(true);
  });
});

describe('getLastSaveTime', () => {
  it('should return null when nothing saved', () => {
    expect(getLastSaveTime()).toBeNull();
  });

  it('should return a Date after saving', () => {
    saveState(minimalState);
    const time = getLastSaveTime();
    expect(time).toBeInstanceOf(Date);
    expect(time!.getTime()).not.toBeNaN();
  });

  it('should return null for corrupt data', () => {
    localStorageMock.getItem.mockReturnValueOnce('not-json');
    expect(getLastSaveTime()).toBeNull();
  });
});
