#!/usr/bin/env bun

import { createInterface } from "node:readline/promises";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";

type LoginMethod = "email-code" | "password";
type BeeperEnv = "prod" | "staging" | "dev" | "local" | "custom";

type MatrixLoginResponse = {
  access_token: string;
  user_id: string;
  device_id?: string;
};

type WhoAmIResponse = {
  user_id: string;
  device_id?: string;
};

type StartLoginResponse = {
  request: string;
};

type SendLoginCodeResponse = {
  token: string;
};

const BEEPER_PRIVATE_LOGIN_AUTH = "BEEPER-PRIVATE-API-PLEASE-DONT-USE";
const BEEPER_ENVS: Record<Exclude<BeeperEnv, "custom">, string> = {
  prod: "beeper.com",
  staging: "beeper-staging.com",
  dev: "beeper-dev.com",
  local: "beeper.localtest.me",
};

function generateDeviceID(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";
  for (let i = 0; i < 8; i += 1) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `chatsdk_${suffix}`;
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function promptWithDefault(question: string, defaultValue: string): Promise<string> {
  const value = await prompt(`${question} [${defaultValue}]: `);
  return value || defaultValue;
}

async function promptSecret(question: string): Promise<string> {
  if (!input.isTTY || !output.isTTY) {
    return prompt(question);
  }

  return await new Promise<string>((resolve) => {
    let value = "";
    output.write(question);
    readline.emitKeypressEvents(input);
    const previousRawMode = input.isRaw;
    input.setRawMode?.(true);

    const onKeypress = (chunk: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        process.exit(130);
      }
      if (key.name === "return" || key.name === "enter") {
        cleanup();
        output.write("\n");
        resolve(value.trim());
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        if (value.length > 0) {
          value = value.slice(0, -1);
          output.write("\b \b");
        }
        return;
      }
      if (chunk && !key.ctrl && !key.meta) {
        value += chunk;
        output.write("*");
      }
    };

    const cleanup = () => {
      input.off("keypress", onKeypress);
      if (previousRawMode !== undefined) {
        input.setRawMode?.(previousRawMode);
      } else {
        input.setRawMode?.(false);
      }
    };

    input.on("keypress", onKeypress);
  });
}

async function promptChoice<T extends string>(
  title: string,
  options: ReadonlyArray<{ key: T; label: string }>,
  defaultKey: T
): Promise<T> {
  output.write(`${title}\n`);
  options.forEach((option, index) => {
    output.write(`  ${index + 1}. ${option.label}\n`);
  });
  const defaultIndex = options.findIndex((option) => option.key === defaultKey) + 1;
  while (true) {
    const raw = await prompt(`Select option [${defaultIndex}]: `);
    const chosenIndex = raw ? Number(raw) : defaultIndex;
    if (Number.isInteger(chosenIndex) && chosenIndex >= 1 && chosenIndex <= options.length) {
      return options[chosenIndex - 1]!.key;
    }
    output.write("Invalid selection.\n");
  }
}

async function requestJSON<T>(
  url: string,
  options: RequestInit,
  opts?: { loginCodeRetryAsInvalid?: boolean }
): Promise<T> {
  const response = await fetch(url, options);
  const text = await response.text();
  const payload = text ? tryParseJSON(text) : null;

  if (!response.ok) {
    if (
      opts?.loginCodeRetryAsInvalid &&
      response.status === 403 &&
      payload &&
      typeof payload === "object" &&
      typeof (payload as Record<string, unknown>).retries === "number" &&
      (payload as Record<string, unknown>).retries > 0
    ) {
      throw new Error(
        `invalid login code (${(payload as Record<string, number>).retries} retries left)`
      );
    }

    const err =
      payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).error === "string"
        ? (payload as Record<string, string>).error
        : text || `HTTP ${response.status}`;
    throw new Error(err);
  }

  return payload as T;
}

function tryParseJSON(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function beeperAPIURL(baseDomain: string, path: string): string {
  return `https://api.${baseDomain}${path}`;
}

function matrixClientURL(baseDomain: string, path: string): string {
  return `https://matrix.${baseDomain}/_matrix/client/v3${path}`;
}

async function emailCodeLogin(
  baseDomain: string,
  deviceID: string,
  initialDeviceDisplayName: string
): Promise<MatrixLoginResponse> {
  const email = await prompt("Email: ");
  if (!email) {
    throw new Error("email is required");
  }

  const beeperHeaders = {
    Authorization: `Bearer ${BEEPER_PRIVATE_LOGIN_AUTH}`,
    "Content-Type": "application/json",
  };

  const start = await requestJSON<StartLoginResponse>(
    beeperAPIURL(baseDomain, "/user/login"),
    {
      method: "POST",
      headers: beeperHeaders,
      body: JSON.stringify({}),
    }
  );

  await requestJSON(
    beeperAPIURL(baseDomain, "/user/login/email"),
    {
      method: "POST",
      headers: beeperHeaders,
      body: JSON.stringify({
        request: start.request,
        email,
      }),
    }
  );

  let loginToken = "";
  while (!loginToken) {
    const code = await prompt("Enter login code sent to your email: ");
    if (!code) {
      output.write("Code is required.\n");
      continue;
    }
    try {
      const result = await requestJSON<SendLoginCodeResponse>(
        beeperAPIURL(baseDomain, "/user/login/response"),
        {
          method: "POST",
          headers: beeperHeaders,
          body: JSON.stringify({
            request: start.request,
            response: code,
          }),
        },
        { loginCodeRetryAsInvalid: true }
      );
      loginToken = result.token;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("invalid login code")) {
        output.write(`${message}\n`);
        continue;
      }
      throw error;
    }
  }

  return await requestJSON<MatrixLoginResponse>(matrixClientURL(baseDomain, "/login"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "org.matrix.login.jwt",
      token: loginToken,
      device_id: deviceID,
      initial_device_display_name: initialDeviceDisplayName,
    }),
  });
}

async function passwordLogin(
  baseDomain: string,
  deviceID: string,
  initialDeviceDisplayName: string
): Promise<MatrixLoginResponse> {
  const username = await prompt("Username: ");
  if (!username) {
    throw new Error("username is required");
  }
  const password = await promptSecret("Password: ");
  if (!password) {
    throw new Error("password is required");
  }

  return await requestJSON<MatrixLoginResponse>(matrixClientURL(baseDomain, "/login"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: {
        type: "m.id.user",
        user: username,
      },
      user: username,
      password,
      device_id: deviceID,
      initial_device_display_name: initialDeviceDisplayName,
    }),
  });
}

async function whoami(baseDomain: string, accessToken: string): Promise<WhoAmIResponse> {
  return await requestJSON<WhoAmIResponse>(matrixClientURL(baseDomain, "/account/whoami"), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
}

async function main(): Promise<void> {
  output.write("Beeper Access Token Helper (Bun)\n\n");

  const env = await promptChoice<BeeperEnv>(
    "Environment:",
    [
      { key: "prod", label: "prod (beeper.com)" },
      { key: "staging", label: "staging (beeper-staging.com)" },
      { key: "dev", label: "dev (beeper-dev.com)" },
      { key: "local", label: "local (beeper.localtest.me)" },
      { key: "custom", label: "custom domain" },
    ],
    "prod"
  );
  const baseDomain =
    env === "custom"
      ? await prompt("Base domain (example: beeper.com): ")
      : BEEPER_ENVS[env];
  if (!baseDomain) {
    throw new Error("base domain is required");
  }

  const loginMethod = await promptChoice<LoginMethod>(
    "Login method:",
    [
      { key: "email-code", label: "email code (Beeper API + JWT Matrix login)" },
      { key: "password", label: "username/password (Matrix login)" },
    ],
    "email-code"
  );

  const defaultDeviceID = generateDeviceID();
  const defaultDeviceName = "chat-sdk matrix token helper";
  const deviceID = await promptWithDefault("Device ID", defaultDeviceID);
  const initialDeviceDisplayName = await promptWithDefault(
    "Initial device display name",
    defaultDeviceName
  );

  const login =
    loginMethod === "email-code"
      ? await emailCodeLogin(baseDomain, deviceID, initialDeviceDisplayName)
      : await passwordLogin(baseDomain, deviceID, initialDeviceDisplayName);

  const me = await whoami(baseDomain, login.access_token);
  const resolvedDeviceID = me.device_id || login.device_id || deviceID;

  output.write("\nSuccess.\n\n");
  output.write("Use these values:\n");
  output.write(`MATRIX_BASE_URL=https://matrix.${baseDomain}\n`);
  output.write(`MATRIX_ACCESS_TOKEN=${login.access_token}\n`);
  output.write(`MATRIX_USER_ID=${me.user_id}\n`);
  output.write(`MATRIX_DEVICE_ID=${resolvedDeviceID}\n\n`);
  output.write("JSON:\n");
  output.write(
    `${JSON.stringify(
      {
        baseURL: `https://matrix.${baseDomain}`,
        accessToken: login.access_token,
        userID: me.user_id,
        deviceID: resolvedDeviceID,
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
