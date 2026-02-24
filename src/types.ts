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
  userID: string;
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
  createClient?: () => MatrixClient;
  deviceID?: string;
  e2ee?: MatrixE2EEConfig;
  logger?: Logger;
  recoveryKey?: string;
  roomAllowlist?: string[];
  sync?: IStartClientOpts;
  userName?: string;
}

export interface MatrixThreadID {
  roomID: string;
  rootEventID?: string;
}
