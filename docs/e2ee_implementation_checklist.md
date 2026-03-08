# E2EE Implementation Checklist

Status: In progress
Last updated: 2026-03-08

## Phase 1: Backend schema foundation

- [x] Add a tracked implementation checklist
- [x] Add SQLAlchemy enums for chat devices and device-link sessions
- [x] Add `ChatDevice` model for active and pending linked devices
- [x] Add `ChatOneTimePrekey` model for per-device public prekeys
- [x] Add `ChatTransportIdentityMapping` model for device-scoped SpaceTime identities
- [x] Add `ChatDeviceLinkSession` model for pending linked-device approvals
- [x] Add an Alembic migration for the new phase 1 tables
- [x] Add backend model coverage for the new phase 1 schema
- [x] Refactor the existing chat bootstrap path to use device-scoped mappings

## Phase 2: Device bootstrap and E2EE backend APIs

- [x] Add `GET /api/v1/chat/e2ee/bootstrap`
- [x] Add `POST /api/v1/chat/e2ee/devices` for first-device registration
- [x] Add linked-device session start, approve, and complete endpoints
- [x] Add signed-prekey rotation and one-time-prekey replenishment endpoints
- [x] Add device-bundle lookup endpoints for users and conversations
- [x] Add device revocation endpoint
- [x] Add backend tests for device registration, linking, bundle fetch, and revocation

## Phase 3: SpaceTimeDB device-aware transport

- [x] Replace user-scoped transport identity mapping with device-scoped mapping
- [x] Add conversation encryption mode and current epoch fields
- [x] Split logical `message` rows from encrypted `message_payload` rows
- [x] Add `conversation_key_package` table
- [x] Add `conversation_membership_event` table
- [x] Replace `register_user_identity` with `register_device_identity`
- [x] Update `send_message` and `my_messages` for device-aware payload delivery
- [x] Add `my_conversation_key_packages` view
- [x] Regenerate frontend SpaceTimeDB bindings

## Phase 4: Frontend crypto foundation

- [x] Add an audited Signal-style frontend crypto dependency
- [x] Add IndexedDB-backed device key storage
- [x] Add device manager and device-link manager modules
- [x] Add prekey, session, group-key, and decryption queue modules
- [x] Update `ChatContext` to bootstrap device-scoped transport and E2EE state
- [x] Keep legacy conversations readable during rollout

## Phase 5: Encrypted direct messages

- [x] Add per-device DM bundle fetch and pairwise session establishment
- [x] Fan out encrypted DM payloads to recipient devices and sender sibling devices
- [x] Render decrypted, pending-keys, failed-to-decrypt, and legacy states
- [x] Add frontend tests for multi-device DM delivery and recovery

## Phase 6: Encrypted groups

- [ ] Add epoch-based sender keys
- [ ] Publish per-device group key packages for every active participant device
- [ ] Rekey on member add, device add, and device revoke
- [ ] Add validation and tests for stale-epoch rejection and membership boundaries

## Phase 7: Final UI and rollout

- [x] Add automated encrypted-chat integration coverage for DM and group UI flows
- [x] Integrate linked-device management into the chat UI
- [x] Add legacy vs E2EE conversation badges
- [ ] Add manual acceptance coverage for two-device DM sync, offline delivery, and group rekey
- [x] Stage rollout behind a feature flag for newly created conversations first
