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

## Notes
- `register_user_identity`, `ensure_dm`, `create_group`, and `add_group_member` are admin-gated reducers; the Flask backend brokers those operations.
- Chat messages are stored as ciphertext payloads, enabling a future end-to-end encryption layer in the frontend.
