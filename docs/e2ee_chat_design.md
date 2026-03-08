# End-to-End Encrypted Chat Design

Status: Proposed
Last updated: 2026-03-08

## Summary

This document defines a concrete design for end-to-end encrypted chat in this repository.

The goals are:

- store only encrypted chat payloads on the server and in SpaceTimeDB
- perform encryption and decryption only in the frontend
- preserve the existing Flask auth model and SpaceTimeDB realtime transport
- support direct messages, group chats, and linked multi-device usage
- keep membership, timestamps, read receipts, typing, and presence as server-visible metadata in v1

This design is intentionally "Signal-like" rather than "full Signal parity." It includes linked multi-device delivery and per-device session setup, but still does not attempt encrypted backups, private contact discovery, or fully automatic historical recovery for newly linked devices.

## Current state

The current chat stack already has the right broad split:

- Flask brokers auth and SpaceTimeDB bootstrap in `resources/chat.py`
- SpaceTimeDB stores conversations, members, messages, read cursors, typing, and presence in `spacetimedb/spacetimedb/src/index.ts`
- React subscribes to those tables in `frontend/src/context/ChatContext.jsx`
- The chat UI displays `message.ciphertext` directly in `frontend/src/components/ChatPage.jsx`

There are two important limitations in the current code:

- the system uses the name `ciphertext`, but the frontend currently sends raw draft text as that value
- transport identity is effectively one-to-one with the user through `ChatIdentityMapping`, which does not support device-specific delivery or per-device key packages

Existing chat rows must therefore be treated as legacy plaintext payloads unless they are explicitly versioned as encrypted.

## Goals

- protect message bodies from the Flask server, PostgreSQL, and SpaceTimeDB operators
- allow users to send messages to offline recipients
- support multiple active devices per user for ongoing message sync
- support group chats with forward access boundaries when membership changes
- keep the existing friend-only chat creation rules
- minimize backend trust: backend may authorize and broker public key material, but never sees private keys or plaintext
- preserve existing chat features where possible: unread counts, typing, read state, presence, and conversation ordering

## Non-goals

- hiding metadata such as conversation membership, timestamps, sender identity, typing, read receipts, or presence
- encrypted push notification previews
- server-side search over message bodies
- attachment encryption in v1
- automatic historical backfill to a newly linked device without help from an existing trusted device
- encrypted backups and account recovery in v1

## V1 product decisions

These decisions keep the implementation realistic while preserving a clear upgrade path:

- multiple active devices per user are supported
- each device has its own E2EE key bundle and its own SpaceTime transport identity
- a newly linked device receives future messages immediately after activation
- a newly linked device does not automatically decrypt old messages that were never encrypted to it
- text messages only in v1
- new group members do not get access to old group history
- read receipts, typing, and presence remain plaintext metadata
- existing conversations stay legacy unless explicitly upgraded or recreated
- private keys are stored only in the browser, in IndexedDB

## Threat model

This design aims to protect message content against:

- a curious or compromised Flask server
- a curious or compromised PostgreSQL database
- a curious or compromised SpaceTimeDB database
- accidental plaintext logging on the server

This design does not protect against:

- a compromised browser runtime or XSS in the frontend
- a compromised end-user device
- a malicious authenticated participant in the conversation
- metadata analysis by the server

The biggest practical security dependency is frontend integrity. If the app serves malicious JavaScript, E2EE is defeated. That is acceptable for this phase, but should be called out clearly.

## Architecture overview

The design splits responsibilities across three layers.

### Flask and PostgreSQL

Flask remains the authenticated broker for:

- device registration
- device linking approval
- public key discovery
- signed prekey rotation
- one-time prekey replenishment
- device revocation
- SpaceTime transport bootstrap for the current device

PostgreSQL stores:

- device metadata
- device public key bundles
- one-time prekeys
- per-device SpaceTime transport identity mappings

No private keys and no plaintext messages are stored here.

### SpaceTimeDB

SpaceTimeDB remains the realtime transport and encrypted message store for:

- conversations
- conversation membership
- logical messages
- message payloads intended for devices or whole encrypted group epochs
- read state
- typing state
- presence
- group key distribution events

### React frontend

The frontend becomes responsible for:

- generating and storing device private keys
- linking new devices
- establishing pairwise sessions between devices
- encrypting outgoing messages
- decrypting incoming messages
- rotating group keys when membership or active-device rosters change
- managing undecryptable message states

## Transport identity model

Multi-device support requires a device-scoped transport identity model.

Current limitation:

- `ChatIdentityMapping` in Flask is effectively one row per user
- `appUserIdentity` in SpaceTimeDB maps one app user to one SpaceTime identity

Required change:

- each active device gets its own SpaceTime identity and websocket token
- SpaceTimeDB maps the websocket sender to both `user_id` and `device_id`

This is required for:

- filtering device-targeted DM payloads
- delivering per-device group key packages
- distinguishing sibling devices belonging to the same user

## Cryptographic approach

The implementation should use an audited Signal-style library or equivalent audited primitives. Do not hand-roll cryptography.

Recommended protocol shape:

- device bootstrap: identity key pair, signing key pair, signed prekey, one-time prekeys
- DM session setup: X3DH-style prekey handshake per sender-device and recipient-device pair
- ongoing DM messages: Double Ratchet per device pair
- group messaging: one sender key per conversation epoch, distributed to every active device of every participant over existing pairwise sessions

Recommended primitive targets:

- key agreement: X25519
- signatures: Ed25519
- KDF: HKDF-SHA-256
- symmetric encryption: AES-256-GCM

If the selected audited library uses an equivalent internal construction, follow the library. The design requirement is the protocol behavior, not a custom primitive implementation.

## Data model changes

Two storage systems need changes: PostgreSQL for the device and public key registry, and SpaceTimeDB for encrypted message transport.

### PostgreSQL models

Add these SQLAlchemy models.

#### `ChatDevice`

Purpose: track every active or pending linked device for a user.

Fields:

- `id`
- `user_id` FK to `user.id`
- `device_id` string UUID, unique
- `label` string, nullable
- `device_kind` enum: `primary`, `linked`
- `status` enum: `pending_link`, `active`, `revoked`
- `identity_key_public` text
- `signing_key_public` text
- `signed_prekey_id` integer
- `signed_prekey_public` text
- `signed_prekey_signature` text
- `linked_at` datetime, nullable
- `last_seen_at` datetime
- `created_at` datetime
- `updated_at` datetime
- `revoked_at` datetime, nullable
- `approved_by_device_id` string UUID, nullable

Constraints:

- unique `(user_id, device_id)`
- multiple active devices per user are allowed

#### `ChatOneTimePrekey`

Purpose: public one-time prekeys consumed during first-contact session establishment.

Fields:

- `id`
- `chat_device_id` FK to `chat_device.id`
- `prekey_id` integer
- `public_key` text
- `claimed_at` datetime, nullable
- `created_at` datetime

Constraints:

- unique `(chat_device_id, prekey_id)`

#### `ChatTransportIdentityMapping`

Purpose: map one linked device to one SpaceTime transport identity.

This replaces the current one-row-per-user `ChatIdentityMapping` behavior.

Fields:

- `id`
- `chat_device_id` FK to `chat_device.id`, unique
- `user_id` FK to `user.id`
- `spacetimedb_identity` string, unique
- `token_encrypted` text
- `created_at` datetime
- `updated_at` datetime

#### `ChatDeviceLinkSession`

Purpose: allow a new browser to become a trusted linked device only after approval from an existing active device.

Fields:

- `id`
- `user_id` FK to `user.id`
- `pending_device_id`
- `pending_identity_key_public`
- `pending_signing_key_public`
- `pending_signed_prekey_id`
- `pending_signed_prekey_public`
- `pending_signed_prekey_signature`
- `status` enum: `pending`, `approved`, `expired`, `consumed`
- `approval_code_hash`
- `approved_by_device_id`, nullable
- `expires_at`
- `created_at`
- `updated_at`

This model is the backend anchor for QR code or short-code approval UX.

### SpaceTimeDB schema changes

SpaceTimeDB should continue to own conversation and realtime state, but it needs explicit device-aware encryption metadata.

#### Replace `app_user_identity` with `app_device_identity`

Purpose: map each SpaceTime sender identity to a user and a device.

Fields:

- `device_id` string primary key
- `user_id` u64
- `identity` identity unique
- `created_at` timestamp
- `revoked_at` optional timestamp

Indexes:

- by `user_id`

#### Change `conversation`

Add fields:

- `encryption_mode`: string enum, `legacy` or `e2ee_v1`
- `current_epoch`: u32

Behavior:

- all existing conversations default to `legacy`
- newly created encrypted conversations use `e2ee_v1` and start at epoch `1`

#### Change `message`

Make `message` the logical message row and move encrypted bodies into a payload table.

Recommended fields:

- `message_id`
- `conversation_id`
- `sender_user_id`
- `sender_device_id`
- `protocol_version`
- `message_type`: `chat` or `system`
- `conversation_epoch`
- `created_at`

#### Add `message_payload`

Purpose: store the actual encrypted body for either device-targeted DM delivery or shared group delivery.

Fields:

- `payload_id`
- `message_id`
- `delivery_scope`: `device` or `conversation`
- `recipient_user_id`, nullable
- `recipient_device_id`, nullable
- `ciphertext`
- `nonce`
- `aad`
- `created_at`

Rules:

- DM messages use one `message_payload` row per target device
- encrypted group messages use one `message_payload` row with `delivery_scope=conversation`
- legacy conversations may continue to use one conversation-scoped payload row

Indexes:

- by `message_id`
- by `recipient_device_id`
- by `recipient_user_id`

#### Add `conversation_key_package`

Purpose: store encrypted group sender keys for each conversation epoch and recipient device.

Fields:

- `package_id`
- `conversation_id`
- `epoch`
- `recipient_user_id`
- `recipient_device_id`
- `sender_user_id`
- `sender_device_id`
- `sealed_sender_key`
- `created_at`

Indexes:

- by `conversation_id`
- by `recipient_device_id`
- by `recipient_user_id`

Behavior:

- every active device in the conversation gets its own package for each epoch
- key packages are not rendered as chat messages

#### Add `conversation_membership_event`

Purpose: record membership changes and active-device roster changes that trigger rekey behavior.

Fields:

- `event_id`
- `conversation_id`
- `event_type`: `member_added`, `member_removed`, `device_added`, `device_revoked`, `conversation_upgraded`
- `target_user_id`
- `target_device_id`, nullable
- `actor_user_id`
- `actor_device_id`, nullable
- `new_epoch`
- `created_at`

This table gives the frontend a deterministic signal that it must fetch or publish a new group key package set.

## API changes

Flask should keep the existing `/api/v1/chat/bootstrap` endpoint, but it must become device-aware.

### `GET /api/v1/chat/bootstrap`

Purpose:

- return SpaceTime websocket credentials for the current active device, not just the current user

Response changes:

- `device_id`
- `user_id`
- `identity`
- `websocket_token`
- `ws_url`
- `db_name`

### `GET /api/v1/chat/e2ee/bootstrap`

Purpose:

- return device linkage state and high-level E2EE status for the current browser session

Response:

- `enabled`
- `current_device_id`, nullable
- `has_active_device`
- `devices`: array of active device summaries
- `remaining_one_time_prekeys`
- `min_one_time_prekeys`

### `POST /api/v1/chat/e2ee/devices`

Purpose:

- register the first trusted device for a user who has no active E2EE device yet

Request body:

- `device_id`
- `label`
- `identity_key_public`
- `signing_key_public`
- `signed_prekey_id`
- `signed_prekey_public`
- `signed_prekey_signature`
- `one_time_prekeys`: array of `{ prekey_id, public_key }`

Server rules:

- the server stores only public material
- if no active device exists, activate this device immediately
- if an active device already exists, require the link-session flow instead

### `POST /api/v1/chat/e2ee/device-links`

Purpose:

- start registration for an additional linked device

Request body:

- `device_id`
- `label`
- `identity_key_public`
- `signing_key_public`
- `signed_prekey_id`
- `signed_prekey_public`
- `signed_prekey_signature`

Response:

- `link_session_id`
- `expires_at`
- `approval_code`

The candidate device displays this code or QR payload to an already active device.

### `POST /api/v1/chat/e2ee/device-links/<link_session_id>/approve`

Purpose:

- approve a pending device from an existing active device

Request body:

- `approval_code`
- `approver_device_id`
- `one_time_prekeys`: initial one-time prekeys for the pending device

Server rules:

- approver device must be active for the same user
- session must be pending and unexpired
- on approval, the pending device becomes active and receives a device-scoped SpaceTime transport mapping

### `POST /api/v1/chat/e2ee/device-links/<link_session_id>/complete`

Purpose:

- let the pending device poll until it becomes active

Response:

- `status`
- `current_device_id`
- `transport_ready`

### `POST /api/v1/chat/e2ee/devices/<device_id>/signed-prekey`

Purpose:

- rotate the signed prekey public bundle for one device

### `POST /api/v1/chat/e2ee/devices/<device_id>/one-time-prekeys`

Purpose:

- replenish one-time prekeys when a device drops below the configured threshold

### `GET /api/v1/chat/e2ee/users/<user_id>/device-bundles`

Purpose:

- fetch every active device bundle for a user
- atomically claim one one-time prekey per returned device when available

Response:

- `user_id`
- `devices`: array of
  - `device_id`
  - `identity_key_public`
  - `signing_key_public`
  - `signed_prekey_id`
  - `signed_prekey_public`
  - `signed_prekey_signature`
  - claimed one-time prekey, if available

### `GET /api/v1/chat/e2ee/conversations/<conversation_id>/device-bundles`

Purpose:

- fetch active device bundles for all current conversation members
- used for group sender-key distribution and device-roster refresh

Server rules:

- caller must be a conversation member

### `POST /api/v1/chat/e2ee/devices/<device_id>/revoke`

Purpose:

- revoke a device and stop future delivery to it

Server behavior:

- mark the device revoked
- invalidate unused one-time prekeys
- revoke its transport mapping
- emit a device-roster change signal so group conversations rotate epochs

## SpaceTimeDB reducer and view changes

### Existing reducers to keep

- `ensure_dm`
- `create_group`
- `add_group_member`
- `send_message`
- `set_typing`
- `mark_read`

### Transport identity reducers

#### Replace `register_user_identity` with `register_device_identity`

Arguments:

- `user_id`
- `device_id`
- `identity`

Behavior:

- register one SpaceTime sender identity for one active device
- allow views to resolve both `user_id` and `device_id` from `ctx.sender`

### Conversation reducers

#### `ensure_dm`

Behavior change:

- accept an optional `encryption_mode`
- new conversations created through the E2EE-capable client should default to `e2ee_v1`

#### `create_group`

Behavior change:

- accept `encryption_mode`
- initialize `current_epoch=1` for encrypted groups

#### `add_group_member`

Behavior change:

- increment `current_epoch`
- insert a `conversation_membership_event`
- do not backfill key material on the server
- rely on an active member device to publish new key packages for every active device in the group

#### New reducer: `emit_device_roster_change`

Purpose:

- signal that a user's active-device roster changed for existing encrypted group conversations

Arguments:

- `user_id`
- `device_id`
- `change_type`: `device_added` or `device_revoked`

Server rules:

- admin-gated from Flask
- emit one `conversation_membership_event` per affected encrypted group

### Message reducer changes

#### `send_message`

Behavior change:

- create one logical `message` row
- accept an array of payload rows instead of one raw `ciphertext` string
- validate payload requirements based on conversation type and encryption mode

Arguments:

- `conversation_id`
- `protocol_version`
- `message_type`
- `conversation_epoch`
- `payloads`: array of
  - `delivery_scope`
  - `recipient_user_id`, nullable
  - `recipient_device_id`, nullable
  - `ciphertext`
  - `nonce`
  - `aad`

Validation rules:

- `legacy` conversations accept one conversation-scoped payload
- encrypted DM messages require one device-scoped payload per target device
- encrypted group messages require one conversation-scoped payload for the current epoch
- stale epochs are rejected for encrypted conversations

#### New reducer: `publish_conversation_key_packages`

Purpose:

- allow a member device to publish group sender key packages for the current epoch

Arguments:

- `conversation_id`
- `epoch`
- `packages`: array of `{ recipient_user_id, recipient_device_id, sealed_sender_key }`

Server rules:

- caller must be a conversation member
- epoch must match `conversation.current_epoch`

### Views

Keep the existing high-level views, but make them device-aware.

#### Existing views to preserve

- `my_conversations`
- `my_typing`
- `my_read_state`
- `my_presence`

#### Replace `my_messages`

`my_messages` should return a normalized view for the current device:

- for DMs, only payload rows targeted at the current `device_id`
- for group conversations, conversation-scoped payload rows for conversations the current user belongs to
- include logical message metadata and the encrypted payload in one row type

#### New view: `my_conversation_key_packages`

Purpose:

- return only key packages intended for the current device

This prevents one device from downloading sealed sender keys intended for another sibling device.

## Frontend design

Frontend work should be isolated in a dedicated crypto layer instead of embedding cryptographic logic directly in `ChatPage.jsx`.

### New frontend modules

Recommended module split:

- `frontend/src/chat/crypto/indexedDbStore.js`
- `frontend/src/chat/crypto/deviceManager.js`
- `frontend/src/chat/crypto/deviceLinkManager.js`
- `frontend/src/chat/crypto/prekeyService.js`
- `frontend/src/chat/crypto/sessionManager.js`
- `frontend/src/chat/crypto/groupKeyManager.js`
- `frontend/src/chat/crypto/messageEnvelope.js`
- `frontend/src/chat/crypto/decryptionQueue.js`

### Private key storage

Private keys should be stored in IndexedDB only.

Storage rules:

- never send private keys to Flask or SpaceTimeDB
- do not write private keys to localStorage
- do not log key material or decrypted message content
- use a non-exportable wrapping key where practical

If browser storage is cleared on one device, that device loses access to encrypted history it cannot recover from another trusted device. Other linked devices remain valid.

### ChatContext responsibilities

`ChatContext.jsx` should continue to manage transport state, but should delegate crypto to the new modules.

Revised responsibilities:

- call `/api/v1/chat/bootstrap` for device-scoped SpaceTime transport
- call `/api/v1/chat/e2ee/bootstrap` for device state
- ensure the current browser is a registered active device before sending encrypted messages
- refresh conversation device rosters when required
- encrypt plaintext before invoking `conn.reducers.sendMessage`
- subscribe to `my_conversation_key_packages`
- decrypt messages after subscription updates
- expose message states to the UI: `decrypted`, `pending_keys`, `failed_to_decrypt`, `legacy`

### ChatPage responsibilities

`ChatPage.jsx` should stop rendering `message.ciphertext` directly.

Instead it should render:

- decrypted plaintext when available
- "Encrypted message: keys unavailable" when the device has not yet received the needed key material
- "Encrypted message could not be decrypted" on terminal failure
- a clear legacy banner for non-E2EE conversations

The UI should also surface linked-device state:

- current device label
- linked devices list
- pending device-link approval flow
- revoke-device action

## Message storage format

The message layer should be explicit and versioned.

### Logical message row

```json
{
  "message_id": "uuid-v7",
  "conversation_id": "dm:12:34",
  "sender_user_id": 12,
  "sender_device_id": "device-a",
  "protocol_version": "e2ee_v1",
  "message_type": "chat",
  "conversation_epoch": 1
}
```

### DM device payload row

```json
{
  "delivery_scope": "device",
  "recipient_user_id": 34,
  "recipient_device_id": "device-b",
  "nonce": "base64...",
  "aad": "base64...",
  "ciphertext": "base64..."
}
```

### Group conversation payload row

```json
{
  "delivery_scope": "conversation",
  "nonce": "base64...",
  "aad": "base64...",
  "ciphertext": "base64..."
}
```

Associated data should include immutable metadata such as:

- `conversation_id`
- `message_id`
- `sender_user_id`
- `sender_device_id`
- `conversation_epoch`
- `protocol_version`

This prevents ciphertext reuse across conversations or epochs.

## Delivery rules

### Direct messages

For encrypted DMs, the sender device must create device-targeted payloads for:

- every active device of the recipient user
- every active sibling device of the sender user

This gives ongoing sync across devices. The originating device may also store a self-targeted payload so reconnects and cold-start history loading do not depend on optimistic local state.

### Group messages

For encrypted groups, the sender device:

- uses the current epoch sender key
- produces one conversation-scoped encrypted payload
- relies on prior `conversation_key_package` delivery so every active device already has the epoch key

If a participant adds or revokes a device, affected groups must rotate to a new epoch and publish fresh key packages for every active device.

## Conversation lifecycle flows

### First trusted device

1. User opens chat on a browser with no registered E2EE device
2. Frontend generates identity key pair, signing key pair, signed prekey, and one-time prekeys
3. Frontend uploads public material to `POST /api/v1/chat/e2ee/devices`
4. Flask provisions a device-scoped SpaceTime identity mapping
5. Frontend stores private material in IndexedDB
6. Chat UI becomes capable of sending encrypted messages

### Link second device

1. Candidate browser generates its own device key bundle locally
2. Candidate browser calls `POST /api/v1/chat/e2ee/device-links`
3. Existing trusted device receives the approval code or QR payload
4. Existing trusted device calls `POST /api/v1/chat/e2ee/device-links/<id>/approve`
5. Flask activates the new device and provisions its transport mapping
6. Candidate browser polls `complete` until active
7. New device can receive future DM fanout payloads and future group key packages

### First DM message

1. User opens or creates a DM
2. Frontend fetches all active device bundles for the recipient
3. Frontend ensures sessions exist from the sending device to each target device
4. Frontend encrypts one payload per recipient device and one payload per sender sibling device
5. Frontend sends one logical message plus payload array through `send_message`
6. Recipient devices receive only their own payload rows and decrypt locally

### Subsequent DM messages

1. Frontend loads the existing ratchet sessions from IndexedDB
2. Frontend refreshes the recipient device roster if needed
3. Frontend encrypts one payload per target device
4. Target devices advance their own pairwise ratchets on decrypt

### Group creation

1. Creator creates a group with `encryption_mode=e2ee_v1`
2. SpaceTimeDB creates the conversation with `current_epoch=1`
3. Creator fetches active device bundles for all members
4. Creator generates a random sender key for epoch 1
5. Creator encrypts that sender key separately for every active device in the group
6. Creator publishes `conversation_key_package` rows
7. Creator sends group chat messages using a conversation-scoped payload encrypted with the epoch 1 sender key

### Add group member

1. Existing reducer adds the new member
2. SpaceTimeDB increments `current_epoch`
3. A `conversation_membership_event` is published
4. Existing members stop sending with the old epoch
5. One active member device fetches current device bundles for all members
6. That device generates a new sender key for the new epoch
7. That device publishes key packages for every active device in the group
8. The new member can decrypt only messages in the new epoch

### Add or revoke a device in an existing encrypted group

1. Flask activates or revokes a device
2. Flask emits device-roster change events for affected encrypted groups
3. SpaceTimeDB increments the conversation epoch for each affected group
4. One active member device publishes fresh key packages for every active device in each group

### Lost device or cleared browser storage

1. User can still authenticate to the app
2. That device cannot decrypt old E2EE history it no longer has keys for
3. User revokes the lost device
4. User links a replacement device
5. Replacement device receives future messages, but old messages remain unavailable unless a trusted device later performs explicit history sharing

## Legacy migration

The repository already has chat data that is logically plaintext even though it uses a field called `ciphertext`.

Migration rules:

- replace the current user-scoped `ChatIdentityMapping` behavior with device-scoped transport mappings
- add `conversation.encryption_mode` and default all existing conversations to `legacy`
- add `message.protocol_version` and use `legacy_plaintext` for old rows
- move encrypted payloads into `message_payload`
- the frontend must branch on protocol version before attempting decryption
- new E2EE conversations must never omit protocol metadata

Recommended UI behavior:

- show a conversation-level badge: `Legacy` or `End-to-end encrypted`
- show device-link status separately from conversation encryption status
- prevent mixing legacy and E2EE semantics without explicit migration

Recommended rollout:

- ship E2EE only for newly created conversations first
- do not auto-upgrade existing conversations in the first release

## Operational rules

- Flask logs must never include ciphertext or decrypted plaintext
- frontend error logging must scrub decrypted content
- notification bodies for encrypted conversations should say only "New message"
- message moderation based on server-side text inspection becomes impossible for encrypted conversations
- friend-only access control remains enforced server-side before any message transport begins
- device linking and revocation should be auditable

## Testing plan

### Backend tests

Add Flask tests for:

- first-device registration
- linked-device approval flow
- device-bundle fetch and atomic one-time-prekey claim behavior
- signed prekey rotation
- device revocation
- device-scoped SpaceTime transport bootstrap
- access control so users can fetch only allowed bundles

### SpaceTimeDB tests

Add module tests for:

- device identity registration
- encrypted conversation creation
- DM payload visibility only to intended devices
- group epoch initialization
- epoch increment on member add
- epoch increment on device roster changes
- rejection of stale-epoch sends
- visibility of key packages only to intended devices

### Frontend unit tests

Add tests for:

- device bootstrap with IndexedDB persistence
- linked-device activation flow
- DM session establishment to multiple recipient devices
- text encrypt/decrypt roundtrip
- sibling-device sync payload generation
- group sender key unwrap and rotation
- rendering of undecryptable states
- legacy conversation fallback

### End-to-end tests

Add browser-level tests for:

- user A with two devices receives messages sent to both
- user A sends encrypted DM to offline user B with two devices, and both B devices decrypt when online
- group creation and initial key distribution to all active devices
- add member to group and verify old messages remain unreadable to the new member
- revoke a device and verify future messages stop reaching it
- browser storage cleared and replacement-device link flow

## Rollout plan

Phase 1:

- add PostgreSQL device, one-time-prekey, link-session, and transport-mapping models
- make SpaceTime transport bootstrap device-scoped
- add conversation and message versioning
- keep message send path legacy by default

Phase 2:

- enable encrypted DMs for newly created conversations
- require per-device DM fanout and linked-device sync

Phase 3:

- enable encrypted groups and per-device key packages
- rotate group epochs on membership and device-roster changes

Phase 4:

- add explicit history-sharing to newly linked devices
- add stronger device verification UX
- add encrypted media and backup strategy

## Implementation notes for this repository

Expected backend files to change when implementation starts:

- `models.py`
- `resources/chat.py`
- `app.py`
- new Alembic migration under `migrations/versions/`

Expected model migrations:

- the current `ChatIdentityMapping` table should be replaced or migrated to a device-scoped transport mapping

Expected SpaceTimeDB files to change:

- `spacetimedb/spacetimedb/src/index.ts`
- regenerated bindings in `frontend/src/spacetimedb/module_bindings/`

Expected frontend files to change:

- `frontend/src/context/ChatContext.jsx`
- `frontend/src/components/ChatPage.jsx`
- new modules under `frontend/src/chat/crypto/`

## Open follow-on work

The following items are intentionally deferred:

- automatic encrypted history backfill to newly linked devices
- polished QR-based device verification UX
- encrypted attachments
- encrypted backups and recovery
- message edits and deletes for encrypted conversations
- push notification integration with encrypted chats

## Recommendation

Implement this design in three passes:

1. device-scoped transport identities and linked-device registry
2. DM E2EE with per-device fanout
3. group sender keys with epoch rotation on membership and device changes

That sequence adds the critical multi-device foundation first instead of layering it on after a single-device protocol.
