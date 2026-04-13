# Changelog

## 0.2.1

### New

- Automatic oversized message splitting: text messages rejected with `M_TOO_LARGE` (413) are retried as plain-text chunks (~12 KB each)
- Thread reply metadata: messages posted to threads now include `m.in_reply_to`, with optional `matrixReplyToEventId` override

### Fixes

- Attachments sent alongside text no longer incorrectly carry the reply-to relationship
- Incoming formatted messages were parsed twice; removed redundant `<mx-reply>` pre-strip pass
- `matrixSDKLogConfigured` flag no longer latches when `setLevel` is missing from the SDK logger

### Changes

- Bump `chat` SDK to 4.25.0
- Move `@chat-adapter/state-memory` and `@chat-adapter/state-redis` to devDependencies

## 0.2.0

### New

- `openDM(userId)` for DM reuse/create
- `fetchMessage(threadId, messageId)` for single-message fetch
- `fetchChannelMessages(channelId, options)` for top-level channel history

### Changes

- `fetchMessages` and `listThreads` use server-backed pagination
- Bump `chat` SDK to 4.15.0
- Clean up event listeners on shutdown
- Guard `decodeRecoveryKey` against malformed keys

## 0.1.0

- Initial release.
