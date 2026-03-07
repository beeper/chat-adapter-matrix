# @beeper/chat-adapter-matrix

Matrix adapter for [Chat SDK](https://chat-sdk.dev/docs).

This adapter runs over Matrix sync, so you do not need to host a webhook endpoint.

If you use Beeper, this adapter lets your Chat SDK bot work with your Matrix/Beeper conversations (including bridged networks such as WhatsApp, Telegram, Instagram, Signal, and others).

## Installation

```bash
pnpm add chat @beeper/chat-adapter-matrix matrix-js-sdk
```

## Quick Start

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

## Authentication

Use either access-token auth or username/password auth.

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
- `MATRIX_BOT_USERNAME` (mention detection display name, defaults to `MOM_BOT_USERNAME` then `bot`)
- `MATRIX_INVITE_AUTOJOIN_ENABLED` (`true`/`false`; defaults to `true` when invite allowlist is set, otherwise `false`)
- `MATRIX_INVITE_AUTOJOIN_ALLOWLIST` (comma-separated Matrix user IDs allowed to invite the bot, e.g. `@alice:beeper.com,@team-bot:beeper.com`)

Advanced options are available for device/session persistence, E2EE storage, and SDK logging (`MATRIX_SDK_LOG_LEVEL`).

## Invite Auto-Join

Enable this when you want the bot to accept incoming room invites automatically.

```ts
createMatrixAdapter({
  baseURL: process.env.MATRIX_BASE_URL!,
  auth: {
    type: "accessToken",
    accessToken: process.env.MATRIX_ACCESS_TOKEN!,
    userID: process.env.MATRIX_USER_ID,
  },
  inviteAutoJoin: {
    enabled: true,
    inviterAllowlist: ["@alice:beeper.com", "@ops:beeper.com"],
  },
});
```

Behavior:

- Only `m.room.member` invites targeted at the bot user are considered.
- If `inviterAllowlist` is set, only those inviters are accepted.
- If `roomAllowlist` is also set, both checks must pass.

## Running The Example

Copy [`examples/.env.example`](./examples/.env.example) to `examples/.env`, then run:

```bash
pnpm example
```

If you need Beeper credentials, generate them interactively:

```bash
pnpm matrix-token
```

The helper prints:

- `MATRIX_BASE_URL`
- `MATRIX_ACCESS_TOKEN`
- `MATRIX_USER_ID`
- `MATRIX_DEVICE_ID`

Then run:

```bash
pnpm example
```

## Capabilities

- `openDM(userId)` creates or reuses direct rooms using Matrix `m.direct` account data and persisted adapter state.
- `fetchMessage(threadId, messageId)` fetches a single message with thread/channel context validation.
- `fetchChannelMessages(channelId, options)` fetches top-level room timeline messages.
- `fetchMessages(threadId, options)` and `listThreads(channelId, options)` use API-first server pagination via `matrix-js-sdk`.
- Inbound Matrix rich text is normalized from `formatted_body` when present, including reply fallback stripping and Matrix pill mention parsing.
- Outbound markdown and Chat SDK mention placeholders are rendered to Matrix `formatted_body` with `org.matrix.custom.html` and `m.mentions`.
- `fetchThread()` and `fetchChannelInfo()` expose room metadata such as `roomID`, DM status, topic, canonical alias, avatar MXC URL, and encryption details when that state is available locally.
- Outbound file support: `files` and binary `attachments` are uploaded with `uploadContent()` and sent as Matrix media messages.
- URL-only attachments are appended as links in the text body.
- `postEphemeral`, `openModal`, and native `stream` are not implemented by this adapter.

## Notes

- `handleWebhook()` returns `501` by design, since this adapter is sync-based.
- Access-token auth resolves identity with `whoami`.
- Password auth sends the configured `device_id` during login.
- Mention sending uses Chat SDK's standard `<@userId>` placeholder syntax and is translated into Matrix pills at send time.
- Matrix reply linkage remains in the raw event/metadata path; the adapter strips the visible quoted fallback from normalized message text.
- For production, use Redis state for stable sessions and device IDs.

For release-specific changes and migration notes, see [CHANGELOG.md](./CHANGELOG.md).

## License

MIT
