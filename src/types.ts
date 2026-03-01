import type { IStartClientOpts, MatrixClient } from "matrix-js-sdk";
import type { Logger } from "chat";

export interface MatrixE2EEConfig {
  cryptoDatabasePrefix?: string;
  enabled?: boolean;
  storageKey?: Uint8Array;
  storagePassword?: string;
  useIndexedDB?: boolean;
}

export interface MatrixAccessTokenAuthConfig {
  accessToken: string;
  type: "accessToken";
  userID?: string;
}

export interface MatrixPasswordAuthConfig {
  initialDeviceDisplayName?: string;
  password: string;
  type: "password";
  userID?: string;
  username: string;
}

export type MatrixAuthConfig =
  | MatrixAccessTokenAuthConfig
  | MatrixPasswordAuthConfig;

export interface MatrixAdapterConfig {
  auth: MatrixAuthConfig;
  baseURL: string;
  commandPrefix?: string;
  createBootstrapClient?: (
    options: { accessToken?: string; baseURL: string; deviceID?: string }
  ) => MatrixAuthBootstrapClient;
  createClient?: () => MatrixClient;
  deviceIDPersistence?: MatrixDeviceIDPersistenceConfig;
  deviceID?: string;
  e2ee?: MatrixE2EEConfig;
  inviteAutoJoin?: MatrixInviteAutoJoinConfig;
  logger?: Logger;
  matrixSDKLogLevel?: "trace" | "debug" | "info" | "warn" | "error";
  recoveryKey?: string;
  roomAllowlist?: string[];
  session?: MatrixSessionConfig;
  sync?: IStartClientOpts;
  userName?: string;
}

export interface MatrixInviteAutoJoinConfig {
  enabled?: boolean;
  inviterAllowlist?: string[];
}

export interface MatrixThreadID {
  roomID: string;
  rootEventID?: string;
}

export interface MatrixSessionConfig {
  enabled?: boolean;
  encrypt?: (value: string) => string;
  key?: string;
  ttlMs?: number;
  decrypt?: (value: string) => string;
}

export interface MatrixDeviceIDPersistenceConfig {
  enabled?: boolean;
  key?: string;
}

export interface MatrixAuthBootstrapClient {
  loginRequest?: (data: {
    type: "m.login.password";
    password: string;
    identifier?: {
      type: "m.id.user";
      user: string;
    };
    user?: string;
    device_id?: string;
    initial_device_display_name?: string;
  }) => Promise<{
    access_token: string;
    device_id?: string;
    user_id?: string;
  }>;
  loginWithPassword: (
    username: string,
    password: string
  ) => Promise<{
    access_token: string;
    device_id?: string;
    user_id?: string;
  }>;
  whoami: () => Promise<{
    device_id?: string;
    user_id?: string;
  }>;
}
