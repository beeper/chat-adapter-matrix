# @beeper/chat-adapter-matrix

Matrix adapter for [Chat SDK](https://chat-sdk.dev/docs).

## Installation

```bash
npm install chat @beeper/chat-adapter-matrix matrix-js-sdk
```

## Usage

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createMatrixAdapter } from "@beeper/chat-adapter-matrix";

const bot = new Chat({
  userName: "beeper-bot",
  state: createMemoryState(),
  adapters: {
    matrix: createMatrixAdapter({
      baseURL: process.env.MATRIX_BASE_URL!,
      auth: {
        type: "accessToken",
        accessToken: process.env.MATRIX_ACCESS_TOKEN!,
        userID: process.env.MATRIX_USER_ID!,
      },
      recoveryKey: process.env.MATRIX_RECOVERY_KEY,
      commandPrefix: "/"
    }),
  },
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`Hi ${message.author.userName}`);
});

bot.onSlashCommand("/ping", async (event) => {
  await event.channel.post("pong");
});
```

## Features

- Matrix sync-based inbound event ingestion (no webhook dependency)
- Mention-aware message forwarding to Chat SDK
- Slash command parsing from text messages (default `/` prefix)
- Reaction add/remove mapping (`m.reaction` + redactions)
- Thread ID encoding for room-level and Matrix thread messages
- Outbound post, edit (replace relation), delete, typing, and reactions
- Optional E2EE support (Rust crypto init + inbound decryption)
- Auto-generated `deviceID` when none is provided
- Typed auth modes: access token or username/password

## Environment Variables

- `MATRIX_BASE_URL`
- `MATRIX_ACCESS_TOKEN` + `MATRIX_USER_ID` for access-token auth
- `MATRIX_USERNAME` + `MATRIX_PASSWORD` for username/password auth
- `MATRIX_DEVICE_ID` (optional)
- `MATRIX_E2EE_ENABLED` (`true`/`false`)
- `MATRIX_E2EE_USE_INDEXEDDB` (`true`/`false`, default `true`)
- `MATRIX_E2EE_DB_PREFIX` (optional)
- `MATRIX_E2EE_STORAGE_PASSWORD` (optional)
- `MATRIX_E2EE_STORAGE_KEY_BASE64` (optional; 32-byte key recommended)
- `MATRIX_RECOVERY_KEY` (if set, E2EE is enabled automatically)

## Limitations

- `handleWebhook()` intentionally returns `501`; Matrix transport is sync/poll driven
- `removeReaction()` redacts only reactions sent by this adapter instance and tracked locally
- If `MATRIX_DEVICE_ID` is not set, a device ID is generated automatically

## License

MIT
