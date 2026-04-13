import type { MatrixAdapterConfig, MatrixAuthConfig, MatrixAccessTokenAuthConfig, MatrixPersistenceConfig } from "./types";
import { normalizeOptionalString } from "./shared/utils";

export const DEFAULT_COMMAND_PREFIX = "/";
export const DEFAULT_PERSISTENCE_KEY_PREFIX = "matrix";
export const DEFAULT_MATRIX_STORE_PERSIST_INTERVAL_MS = 30_000;
export const FAST_SYNC_DEFAULTS: NonNullable<MatrixAdapterConfig["sync"]> = {
  initialSyncLimit: 1,
  lazyLoadMembers: true,
  disablePresence: true,
  pollTimeout: 10_000,
};

export type SDKLogLevel = NonNullable<MatrixAdapterConfig["matrixSDKLogLevel"]>;

export type ResolvedPersistenceConfig = {
  keyPrefix: string;
  session: Pick<NonNullable<MatrixPersistenceConfig["session"]>, "decrypt" | "encrypt" | "ttlMs">;
  sync: Required<Pick<NonNullable<MatrixPersistenceConfig["sync"]>, "persistIntervalMs">> &
    Pick<NonNullable<MatrixPersistenceConfig["sync"]>, "snapshotTtlMs">;
};

export function validateConfig(config: MatrixAdapterConfig): void {
  if (!config.baseURL?.trim()) {
    throw new Error("baseURL is required.");
  }
  if (config.persistence?.session?.ttlMs !== undefined && config.persistence.session.ttlMs <= 0) {
    throw new Error("persistence.session.ttlMs must be a positive number.");
  }
  if (
    config.persistence?.sync?.persistIntervalMs !== undefined &&
    config.persistence.sync.persistIntervalMs <= 0
  ) {
    throw new Error("persistence.sync.persistIntervalMs must be a positive number.");
  }
  if (
    config.persistence?.sync?.snapshotTtlMs !== undefined &&
    config.persistence.sync.snapshotTtlMs <= 0
  ) {
    throw new Error("persistence.sync.snapshotTtlMs must be a positive number.");
  }
  if (
    (config.persistence?.session?.encrypt && !config.persistence?.session?.decrypt) ||
    (!config.persistence?.session?.encrypt && config.persistence?.session?.decrypt)
  ) {
    throw new Error(
      "persistence.session.encrypt and persistence.session.decrypt must be provided together."
    );
  }
}

export function normalizePersistenceConfig(
  config?: MatrixPersistenceConfig
): ResolvedPersistenceConfig {
  return {
    keyPrefix:
      normalizeOptionalString(config?.keyPrefix) ?? DEFAULT_PERSISTENCE_KEY_PREFIX,
    session: {
      decrypt: config?.session?.decrypt,
      encrypt: config?.session?.encrypt,
      ttlMs: config?.session?.ttlMs,
    },
    sync: {
      persistIntervalMs:
        config?.sync?.persistIntervalMs ??
        DEFAULT_MATRIX_STORE_PERSIST_INTERVAL_MS,
      snapshotTtlMs: config?.sync?.snapshotTtlMs,
    },
  };
}

export function resolveAuthFromEnv(): MatrixAuthConfig {
  const username = process.env.MATRIX_USERNAME;
  const password = process.env.MATRIX_PASSWORD;

  if (username && password) {
    return {
      type: "password",
      username,
      password,
      userID: process.env.MATRIX_USER_ID,
    };
  }

  const accessToken = process.env.MATRIX_ACCESS_TOKEN;
  const userID = process.env.MATRIX_USER_ID;

  if (!accessToken) {
    throw new Error(
      "Set MATRIX_USERNAME+MATRIX_PASSWORD for password auth, or MATRIX_ACCESS_TOKEN for access token auth."
    );
  }

  const auth: MatrixAccessTokenAuthConfig = {
    type: "accessToken",
    accessToken,
    userID,
  };

  return auth;
}

function envBool(value: string | undefined, fallback = false): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function parseEnvList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isSDKLogLevel(value: string): value is SDKLogLevel {
  return value === "trace" ||
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error";
}

export function parseSDKLogLevel(value: string | undefined): SDKLogLevel | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return isSDKLogLevel(normalized) ? normalized : undefined;
}

export function createMatrixAdapterConfigFromEnv(): MatrixAdapterConfig {
  const baseURL = process.env.MATRIX_BASE_URL;
  if (!baseURL) {
    throw new Error("baseURL is required. Set MATRIX_BASE_URL.");
  }

  const recoveryKey = process.env.MATRIX_RECOVERY_KEY;
  const inviteAutoJoinInviterAllowlist = parseEnvList(
    process.env.MATRIX_INVITE_AUTOJOIN_ALLOWLIST
  );
  const inviteAutoJoinEnabled = envBool(
    process.env.MATRIX_INVITE_AUTOJOIN,
    inviteAutoJoinInviterAllowlist.length > 0
  );

  return {
    baseURL,
    auth: resolveAuthFromEnv(),
    userName: process.env.MATRIX_BOT_USERNAME ?? "bot",
    deviceID: normalizeOptionalString(process.env.MATRIX_DEVICE_ID),
    commandPrefix: process.env.MATRIX_COMMAND_PREFIX,
    recoveryKey,
    inviteAutoJoin: inviteAutoJoinEnabled
      ? {
          inviterAllowlist: inviteAutoJoinInviterAllowlist,
        }
      : undefined,
    matrixSDKLogLevel:
      parseSDKLogLevel(process.env.MATRIX_SDK_LOG_LEVEL) ?? "error",
  };
}
