import type { ICreateClientOpts, IStartClientOpts, MatrixClient } from "matrix-js-sdk";
import type { Logger, StateAdapter } from "chat";
import type { IStore } from "matrix-js-sdk/lib/store";

export interface MatrixE2EEConfig {
  cryptoDatabasePrefix?: string;
  storageKey?: Uint8Array;
  storagePassword?: string;
  useIndexedDB?: boolean;
}

export interface MatrixPersistenceSyncConfig {
  persistIntervalMs?: number;
  snapshotTtlMs?: number;
}

export interface MatrixPersistenceSessionConfig {
  decrypt?: (value: string) => string;
  encrypt?: (value: string) => string;
  ttlMs?: number;
}

export interface MatrixPersistenceConfig {
  keyPrefix?: string;
  session?: MatrixPersistenceSessionConfig;
  sync?: MatrixPersistenceSyncConfig;
}

export interface MatrixCreateStoreOptions {
  baseURL: string;
  config: MatrixPersistenceSyncConfig;
  deviceID?: string;
  logger: Logger;
  scopeKey: string;
  state: StateAdapter;
  userID: string;
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
  createStore?: (options: MatrixCreateStoreOptions) => IStore;
  createBootstrapClient?: (
    options: { accessToken?: string; baseURL: string; deviceID?: string }
  ) => MatrixAuthBootstrapClient;
  createClient?: (options?: ICreateClientOpts) => MatrixClient;
  deviceID?: string;
  e2ee?: MatrixE2EEConfig;
  inviteAutoJoin?: MatrixInviteAutoJoinConfig;
  logger?: Logger;
  matrixSDKLogLevel?: "trace" | "debug" | "info" | "warn" | "error";
  persistence?: MatrixPersistenceConfig;
  recoveryKey?: string;
  roomAllowlist?: string[];
  sync?: IStartClientOpts;
  userName?: string;
}

export interface MatrixInviteAutoJoinConfig {
  inviterAllowlist?: string[];
}

export interface MatrixThreadID {
  roomID: string;
  rootEventID?: string;
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
