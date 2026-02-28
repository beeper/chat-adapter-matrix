# @beeper/chat-adapter-matrix

Matrix adapter for [Chat SDK](https://chat-sdk.dev/docs). Uses Matrix sync (no webhook server required).

If you are using Beeper, you can use Chat SDK with your Beeper Cloud accounts and Matrix chats. This lets you use Chat SDK with WhatsApp, Telegram, Instagram, Signal, X Chat, and more. For bridged chats, we recommend personal usage, since some networks may limit automated activity.

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
      },
      recoveryKey: process.env.MATRIX_RECOVERY_KEY,
    }),
  },
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  await thread.post(`Hi ${message.author.userName}`);
});
```

## Auth

Access token:

```ts
auth: { type: "accessToken", accessToken: process.env.MATRIX_ACCESS_TOKEN! };
```

Username/password:

```ts
auth: {
  type: "password",
  username: process.env.MATRIX_USERNAME!,
  password: process.env.MATRIX_PASSWORD!,
};
```

## Environment

Required:

- `MATRIX_BASE_URL`
- Access token mode: `MATRIX_ACCESS_TOKEN`
- Password mode: `MATRIX_USERNAME`, `MATRIX_PASSWORD`

Common optional:

- `MATRIX_USER_ID`
- `MATRIX_DEVICE_ID`
- `MATRIX_RECOVERY_KEY`

Advanced optional (only if needed): device ID persistence keys, E2EE storage settings, session settings, and `MATRIX_SDK_LOG_LEVEL`.

## Examples

Copy [`examples/.env.example`](./examples/.env.example) to `examples/.env`, then run:

```bash
npm run example:bun
```

Generate a Beeper access token interactively:

```bash
npm run token:bun
```

## Get a Beeper Access Token

Use the interactive helper:

```bash
npm run token:bun
```

It prints:

- `MATRIX_BASE_URL`
- `MATRIX_ACCESS_TOKEN`
- `MATRIX_USER_ID`
- `MATRIX_DEVICE_ID`

Paste those values into `examples/.env` or your deployment secrets.

or:

```bash
bun --env-file=examples/.env run examples/bot.ts
```

## Notes

- `handleWebhook()` returns `501` by design.
- Access-token auth resolves identity with `whoami`.
- Password auth sends configured `device_id` during login.
- Use Redis state in production for stable sessions and device IDs.

## Feature Parity (v1+)

- `openDM(userId)` is supported and reuses/creates direct rooms using Matrix `m.direct` account data plus persisted adapter state.
- `fetchMessage(threadId, messageId)` is supported and validates room/thread context.
- `fetchChannelMessages(channelId, options)` is supported for top-level room timeline messages.
- `fetchMessages(threadId, options)` is API-first and server-paginated (not `room.timeline` dependent).
- `listThreads(channelId, options)` is server-backed via Matrix thread list APIs.
- `postEphemeral`, `openModal`, and native `stream` are intentionally not implemented in this adapter.

## Breaking Changes In 1.0.0

- Cursor format changed to opaque adapter cursors: `mxv1:<base64url-json>`.
- Legacy cursor strings from pre-1.0 releases are rejected with `Invalid cursor format. Expected mxv1 cursor.`.
- `fetchMessages(threadId)` for Matrix thread IDs returns root + replies (root included on first page), with server pagination.

## Cursor Migration

- Treat all previously stored cursors as invalid when upgrading to `1.x`.
- Drop persisted history cursors and request the first page again.
- New cursors are scoped to method/context and cannot be reused across rooms/threads.

## Pagination Behavior

- Paged history methods use `matrix-js-sdk` server APIs.
- Pages are normalized to chronological order.
- `nextCursor` is returned only when the server indicates more results.

## License

MIT
