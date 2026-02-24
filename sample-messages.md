# Sample Matrix Payloads

These examples help debug adapter mapping and event ingestion.

## m.room.message (text)

```json
{
  "type": "m.room.message",
  "event_id": "$text1:example.com",
  "sender": "@alice:example.com",
  "room_id": "!room:example.com",
  "origin_server_ts": 1700000000000,
  "content": {
    "msgtype": "m.text",
    "body": "hello matrix"
  }
}
```

## m.room.message (thread reply)

```json
{
  "type": "m.room.message",
  "event_id": "$reply1:example.com",
  "sender": "@alice:example.com",
  "room_id": "!room:example.com",
  "origin_server_ts": 1700000001000,
  "content": {
    "msgtype": "m.text",
    "body": "thread reply",
    "m.relates_to": {
      "rel_type": "m.thread",
      "event_id": "$root1:example.com"
    }
  }
}
```

## m.room.encrypted

```json
{
  "type": "m.room.encrypted",
  "event_id": "$enc1:example.com",
  "sender": "@alice:example.com",
  "room_id": "!room:example.com",
  "origin_server_ts": 1700000002000,
  "content": {
    "algorithm": "m.megolm.v1.aes-sha2",
    "ciphertext": "...",
    "sender_key": "...",
    "session_id": "...",
    "device_id": "ALICEDEVICE"
  }
}
```

## m.room.message (edit via m.replace)

```json
{
  "type": "m.room.message",
  "event_id": "$edit1:example.com",
  "sender": "@alice:example.com",
  "room_id": "!room:example.com",
  "origin_server_ts": 1700000002500,
  "content": {
    "msgtype": "m.text",
    "body": "* hello updated",
    "m.new_content": {
      "msgtype": "m.text",
      "body": "hello updated"
    },
    "m.relates_to": {
      "rel_type": "m.replace",
      "event_id": "$text1:example.com"
    }
  }
}
```

## m.room.message (file)

```json
{
  "type": "m.room.message",
  "event_id": "$file1:example.com",
  "sender": "@alice:example.com",
  "room_id": "!room:example.com",
  "origin_server_ts": 1700000002600,
  "content": {
    "msgtype": "m.file",
    "body": "report.pdf",
    "url": "mxc://example.com/abc123",
    "info": {
      "mimetype": "application/pdf"
    }
  }
}
```

## m.reaction (add)

```json
{
  "type": "m.reaction",
  "event_id": "$reaction1:example.com",
  "sender": "@alice:example.com",
  "room_id": "!room:example.com",
  "origin_server_ts": 1700000003000,
  "content": {
    "m.relates_to": {
      "rel_type": "m.annotation",
      "event_id": "$text1:example.com",
      "key": "👍"
    }
  }
}
```

## m.room.redaction (reaction remove)

```json
{
  "type": "m.room.redaction",
  "event_id": "$redact1:example.com",
  "sender": "@alice:example.com",
  "room_id": "!room:example.com",
  "origin_server_ts": 1700000004000,
  "redacts": "$reaction1:example.com",
  "content": {}
}
```
