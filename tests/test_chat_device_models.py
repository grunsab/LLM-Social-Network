from datetime import datetime, timedelta, timezone

from models import (
    ChatDevice,
    ChatDeviceKind,
    ChatDeviceLinkSession,
    ChatDeviceLinkSessionStatus,
    ChatDeviceStatus,
    ChatOneTimePrekey,
    ChatTransportIdentityMapping,
)


def test_chat_phase_one_models_support_multiple_devices_per_user(db_session, create_user):
    user = create_user(username='chatdeviceowner', email='chatdeviceowner@example.com')

    primary_device = ChatDevice(
        user_id=user.id,
        device_id='device-primary-0001',
        label='MacBook Pro',
        device_kind=ChatDeviceKind.PRIMARY,
        status=ChatDeviceStatus.ACTIVE,
        identity_key_public='identity-public-1',
        signing_key_public='signing-public-1',
        signed_prekey_id=101,
        signed_prekey_public='signed-prekey-public-1',
        signed_prekey_signature='signed-prekey-signature-1',
        linked_at=datetime.now(timezone.utc),
    )
    linked_device = ChatDevice(
        user_id=user.id,
        device_id='device-linked-0002',
        label='iPhone',
        device_kind=ChatDeviceKind.LINKED,
        status=ChatDeviceStatus.ACTIVE,
        identity_key_public='identity-public-2',
        signing_key_public='signing-public-2',
        signed_prekey_id=202,
        signed_prekey_public='signed-prekey-public-2',
        signed_prekey_signature='signed-prekey-signature-2',
        linked_at=datetime.now(timezone.utc),
        approved_by_device_id='device-primary-0001',
    )

    db_session.add_all([primary_device, linked_device])
    db_session.flush()

    db_session.add_all([
        ChatTransportIdentityMapping(
            chat_device_id=primary_device.id,
            user_id=user.id,
            spacetimedb_identity=f"0x{'1' * 64}",
            token_encrypted='encrypted-token-1',
        ),
        ChatTransportIdentityMapping(
            chat_device_id=linked_device.id,
            user_id=user.id,
            spacetimedb_identity=f"0x{'2' * 64}",
            token_encrypted='encrypted-token-2',
        ),
        ChatOneTimePrekey(
            chat_device_id=primary_device.id,
            prekey_id=1,
            public_key='prekey-public-1',
        ),
        ChatOneTimePrekey(
            chat_device_id=linked_device.id,
            prekey_id=1,
            public_key='prekey-public-2',
        ),
    ])
    db_session.commit()

    db_session.refresh(user)

    assert len(user.chat_devices) == 2
    assert primary_device.transport_identity_mapping.user_id == user.id
    assert linked_device.transport_identity_mapping.user_id == user.id
    assert linked_device.approved_by_device.device_id == primary_device.device_id
    assert [prekey.public_key for prekey in primary_device.one_time_prekeys] == ['prekey-public-1']


def test_chat_device_link_session_tracks_pending_device_and_approver(db_session, create_user):
    user = create_user(username='linksessionowner', email='linksessionowner@example.com')
    approver_device = ChatDevice(
        user_id=user.id,
        device_id='device-approver-0001',
        label='Desktop',
        device_kind=ChatDeviceKind.PRIMARY,
        status=ChatDeviceStatus.ACTIVE,
        identity_key_public='identity-public-approver',
        signing_key_public='signing-public-approver',
        signed_prekey_id=77,
        signed_prekey_public='signed-prekey-public-approver',
        signed_prekey_signature='signed-prekey-signature-approver',
        linked_at=datetime.now(timezone.utc),
    )
    db_session.add(approver_device)
    db_session.flush()

    link_session = ChatDeviceLinkSession(
        user_id=user.id,
        pending_device_id='device-pending-0009',
        pending_identity_key_public='pending-identity-public',
        pending_signing_key_public='pending-signing-public',
        pending_signed_prekey_id=88,
        pending_signed_prekey_public='pending-signed-prekey-public',
        pending_signed_prekey_signature='pending-signed-prekey-signature',
        status=ChatDeviceLinkSessionStatus.PENDING,
        approval_code_hash='hashed-approval-code',
        approved_by_device_id=approver_device.device_id,
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=10),
    )

    db_session.add(link_session)
    db_session.commit()

    assert link_session.user_id == user.id
    assert link_session.pending_device_id == 'device-pending-0009'
    assert link_session.status == ChatDeviceLinkSessionStatus.PENDING
    assert link_session.approved_by_device.device_id == approver_device.device_id
