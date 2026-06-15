/**
 * Core types for Splunk App Builder
 */

import type { ComponentsConfig } from './components';
import { DEFAULT_COMPONENTS_CONFIG } from './components';

export interface AppMetadata {
  name: string;
  displayName: string;
  description: string;
  author: string;
  email: string;
  version: string;
  appId: string;
  licenseName: string;
  licenseUri: string;
}

export interface BrandingConfig {
  logoFile?: File | null;
  logoDataUrl?: string; // Original upload
  processedIcons?: {
    // Resized icons ready for VFS
    appIcon: string;
    appIcon2x: string;
    appIconAlt: string;
    appIconAlt2x: string;
  };
  navBarColor: string;
}

export interface WizardState {
  currentStep: number;
  metadata: AppMetadata;
  branding: BrandingConfig;
  components: ComponentsConfig;
}

export const DEFAULT_WIZARD_STATE: WizardState = {
  currentStep: 0,
  metadata: {
    name: '',
    displayName: '',
    description: '',
    author: '',
    email: '',
    version: '1.0.0',
    appId: '',
    licenseName: 'Apache-2.0',
    licenseUri: 'https://www.apache.org/licenses/LICENSE-2.0',
  },
  branding: {
    logoFile: null,
    logoDataUrl: undefined,
    navBarColor: '#65A637', // Splunk green
  },
  components: DEFAULT_COMPONENTS_CONFIG,
};

type WizardStep = 'details' | 'branding' | 'components' | 'review';

export const WIZARD_STEPS: { id: WizardStep; label: string }[] = [
  { id: 'details', label: 'App Details' },
  { id: 'branding', label: 'Branding' },
  { id: 'components', label: 'Components' },
  { id: 'review', label: 'Review & Generate' },
];
