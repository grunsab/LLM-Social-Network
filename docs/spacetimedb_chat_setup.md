# SpaceTimeDB Chat Setup

## Module Source
- Module path: `spacetimedb/spacetimedb`
- Hosted database name: `socialnetworkdotsocial-48xhr`
- Hosted database ID: `c20069a056fa0538d26edbfe04785fe43b106f2fd5721f4a6555cf67f4090f93`

## Local Build
```bash
cd spacetimedb/spacetimedb
PATH="$HOME/.local/bin:$PATH" npm install
PATH="$HOME/.local/bin:$PATH" npm run build
```

## Generate Frontend Bindings
```bash
PATH="$HOME/.local/bin:$PATH" spacetime generate \
  --lang typescript \
  --module-path spacetimedb/spacetimedb \
  --out-dir frontend/src/spacetimedb/module_bindings \
  --yes
```

## Publish To Maincloud
```bash
PATH="$HOME/.local/bin:$PATH" spacetime login
PATH="$HOME/.local/bin:$PATH" spacetime publish socialnetworkdotsocial-48xhr \
  --module-path spacetimedb/spacetimedb
```

## Required Backend Environment Variables
- `SPACETIMEDB_HTTP_URL` (default: `https://maincloud.spacetimedb.com`)
- `SPACETIMEDB_WS_URL` (default: `wss://maincloud.spacetimedb.com`)
- `SPACETIMEDB_DB_NAME` (set to `socialnetworkdotsocial-48xhr`)
- `SPACETIMEDB_DB_ID` (set to `c20069a056fa0538d26edbfe04785fe43b106f2fd5721f4a6555cf67f4090f93`)
- `SPACETIMEDB_SERVICE_TOKEN` (owner/admin identity token for server-side reducers)
- `SPACETIMEDB_TOKEN_ENCRYPTION_KEY` (Fernet key for encrypted identity token storage)
- `CHAT_E2EE_ENABLED` (default: `1`, master switch for device bootstrap and encrypted transport)
- `CHAT_E2EE_NEW_CONVERSATIONS_ENABLED` (default: `0`, rollout gate for creating new `e2ee_v1` conversations)
- `CHAT_MIN_ONE_TIME_PREKEYS` (default: `10`, floor before the client tops up one-time prekeys)
- `CHAT_DEVICE_LINK_TTL_MINUTES` (default: `10`, expiration window for linked-device approvals)

## Notes
- `register_device_identity`, `emit_device_roster_change`, `ensure_dm`, `create_group`, and `add_group_member` are admin-gated reducers; the Flask backend brokers those operations.
- Chat transport is now device-aware: logical `message` rows are separate from `message_payload` delivery rows, and group sender keys flow through `conversation_key_package`.
