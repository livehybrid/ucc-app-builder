/**
 * GitHub Integration Types
 */

export interface GitHubAuth {
  accessToken: string;
  tokenType: string;
  scope: string;
}

export interface GitHubUser {
  login: string;
  id: number;
  avatar_url: string;
  name: string;
  email?: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  default_branch: string;
  permissions?: {
    admin: boolean;
    push: boolean;
    pull: boolean;
  };
}

export interface DeviceFlowResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface GitHubSession {
  auth: GitHubAuth;
  user: GitHubUser;
  selectedRepo?: GitHubRepo;
  lastSync?: string;
}
