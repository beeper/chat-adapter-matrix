# Changelog

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
