from datetime import datetime, timedelta, timezone

from extensions import db
from models import (
    ChatDevice,
    ChatDeviceKind,
    ChatDeviceStatus,
    ChatOneTimePrekey,
    ChatTransportIdentityMapping,
)
from tests.test_chat_resource import _befriend, _login_user, _mock_spacetime, _register_user


def _device_payload(device_id, *, include_prekeys=True):
    payload = {
        'device_id': device_id,
        'label': f'label-{device_id}',
        'identity_key_public': f'identity-{device_id}',
        'signing_key_public': f'signing-{device_id}',
        'signed_prekey_id': 101,
        'signed_prekey_public': f'signed-prekey-{device_id}',
        'signed_prekey_signature': f'signed-prekey-signature-{device_id}',
    }
    if include_prekeys:
        payload['one_time_prekeys'] = [
            {'prekey_id': 1, 'public_key': f'prekey-1-{device_id}'},
            {'prekey_id': 2, 'public_key': f'prekey-2-{device_id}'},
        ]
    return payload


def _create_chat_device(app, user_id, device_id, *, prekey_count=2):
    with app.app_context():
        device = ChatDevice(
            user_id=user_id,
            device_id=device_id,
            label=f'label-{device_id}',
            device_kind=ChatDeviceKind.PRIMARY,
            status=ChatDeviceStatus.ACTIVE,
            identity_key_public=f'identity-{device_id}',
            signing_key_public=f'signing-{device_id}',
            signed_prekey_id=101,
            signed_prekey_public=f'signed-prekey-{device_id}',
            signed_prekey_signature=f'signed-prekey-signature-{device_id}',
            linked_at=datetime.now(timezone.utc),
        )
        db.session.add(device)
        db.session.flush()
        db.session.add(ChatTransportIdentityMapping(
            chat_device_id=device.id,
            user_id=user_id,
            spacetimedb_identity=f"0x{device.id:064x}",
            token_encrypted=f'encrypted-token-{device_id}',
        ))
        for offset in range(prekey_count):
            db.session.add(ChatOneTimePrekey(
                chat_device_id=device.id,
                prekey_id=offset + 1,
                public_key=f'prekey-{offset + 1}-{device_id}',
            ))
        db.session.commit()
        return device.id


def test_e2ee_bootstrap_reports_no_active_device(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    _register_user(client, 'e2ee_bootstrap_user', 'e2ee_bootstrap_user@example.com')
    _login_user(client, 'e2ee_bootstrap_user')

    response = client.get('/api/v1/chat/e2ee/bootstrap')
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['enabled'] is True
    assert payload['new_conversations_enabled'] is True
    assert payload['has_active_device'] is False
    assert payload['current_device_id'] is None
    assert payload['devices'] == []


def test_e2ee_device_registration_creates_active_device_and_transport_mapping(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    _register_user(client, 'e2ee_register_user', 'e2ee_register_user@example.com')
    user_id = _login_user(client, 'e2ee_register_user')

    response = client.post('/api/v1/chat/e2ee/devices', json=_device_payload('device-primary-001'))
    assert response.status_code == 201, response.get_json()
    payload = response.get_json()
    assert payload['device']['device_id'] == 'device-primary-001'
    assert payload['transport_ready'] is True
    assert payload['remaining_one_time_prekeys'] == 2

    bootstrap_response = client.get('/api/v1/chat/e2ee/bootstrap')
    assert bootstrap_response.status_code == 200
    bootstrap_payload = bootstrap_response.get_json()
    assert bootstrap_payload['current_device_id'] == 'device-primary-001'
    assert bootstrap_payload['has_active_device'] is True
    assert bootstrap_payload['new_conversations_enabled'] is True
    assert bootstrap_payload['remaining_one_time_prekeys'] == 2

    with client.application.app_context():
        device = ChatDevice.query.filter_by(user_id=user_id, device_id='device-primary-001').first()
        assert device is not None
        assert device.status == ChatDeviceStatus.ACTIVE
        assert device.transport_identity_mapping is not None
        assert ChatOneTimePrekey.query.filter_by(chat_device_id=device.id).count() == 2


def test_e2ee_device_link_approve_and_complete_flow(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    approver_client = client
    candidate_client = client.application.test_client()

    _register_user(approver_client, 'e2ee_link_user', 'e2ee_link_user@example.com')
    _login_user(approver_client, 'e2ee_link_user')
    register_response = approver_client.post('/api/v1/chat/e2ee/devices', json=_device_payload('device-primary-010'))
    assert register_response.status_code == 201, register_response.get_json()

    _login_user(candidate_client, 'e2ee_link_user')
    link_start_response = candidate_client.post(
        '/api/v1/chat/e2ee/device-links',
        json=_device_payload('device-linked-011', include_prekeys=False)
    )
    assert link_start_response.status_code == 201, link_start_response.get_json()
    link_payload = link_start_response.get_json()

    approve_response = approver_client.post(
        f"/api/v1/chat/e2ee/device-links/{link_payload['link_session_id']}/approve",
        json={
            'approval_code': link_payload['approval_code'],
            'approver_device_id': 'device-primary-010',
            'one_time_prekeys': [
                {'prekey_id': 9, 'public_key': 'linked-prekey-9'},
                {'prekey_id': 10, 'public_key': 'linked-prekey-10'},
            ],
        }
    )
    assert approve_response.status_code == 200, approve_response.get_json()
    approve_payload = approve_response.get_json()
    assert approve_payload['device']['device_id'] == 'device-linked-011'
    assert approve_payload['transport_ready'] is True

    complete_response = candidate_client.post(
        f"/api/v1/chat/e2ee/device-links/{link_payload['link_session_id']}/complete"
    )
    assert complete_response.status_code == 200
    complete_payload = complete_response.get_json()
    assert complete_payload['status'] == 'active'
    assert complete_payload['current_device_id'] == 'device-linked-011'
    assert complete_payload['transport_ready'] is True


def test_e2ee_device_link_can_be_approved_without_prekeys(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    approver_client = client
    candidate_client = client.application.test_client()

    _register_user(approver_client, 'e2ee_link_no_prekeys_user', 'e2ee_link_no_prekeys_user@example.com')
    _login_user(approver_client, 'e2ee_link_no_prekeys_user')
    register_response = approver_client.post('/api/v1/chat/e2ee/devices', json=_device_payload('device-primary-020'))
    assert register_response.status_code == 201, register_response.get_json()

    _login_user(candidate_client, 'e2ee_link_no_prekeys_user')
    link_start_response = candidate_client.post(
        '/api/v1/chat/e2ee/device-links',
        json=_device_payload('device-linked-021', include_prekeys=False)
    )
    assert link_start_response.status_code == 201, link_start_response.get_json()
    link_payload = link_start_response.get_json()

    approve_response = approver_client.post(
        f"/api/v1/chat/e2ee/device-links/{link_payload['link_session_id']}/approve",
        json={
            'approval_code': link_payload['approval_code'],
            'approver_device_id': 'device-primary-020',
        }
    )
    assert approve_response.status_code == 200, approve_response.get_json()
    assert approve_response.get_json()['remaining_one_time_prekeys'] == 0

    complete_response = candidate_client.post(
        f"/api/v1/chat/e2ee/device-links/{link_payload['link_session_id']}/complete"
    )
    assert complete_response.status_code == 200
    complete_payload = complete_response.get_json()
    assert complete_payload['status'] == 'active'
    assert complete_payload['current_device_id'] == 'device-linked-021'


def test_e2ee_user_device_bundles_claim_friend_prekeys(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    current_user_id = _register_user(client, 'e2ee_bundle_me', 'e2ee_bundle_me@example.com')
    friend_id = _register_user(client, 'e2ee_bundle_friend', 'e2ee_bundle_friend@example.com')
    _befriend(client, 'e2ee_bundle_me', 'e2ee_bundle_friend', friend_id)

    _create_chat_device(client.application, friend_id, 'device-friend-001')

    _login_user(client, 'e2ee_bundle_me')
    response = client.get(f'/api/v1/chat/e2ee/users/{friend_id}/device-bundles')
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['user_id'] == friend_id
    assert payload['devices'][0]['device_id'] == 'device-friend-001'
    assert payload['devices'][0]['one_time_prekey']['prekey_id'] == 1

    with client.application.app_context():
        friend_device = ChatDevice.query.filter_by(user_id=friend_id, device_id='device-friend-001').first()
        claimed = ChatOneTimePrekey.query.filter_by(chat_device_id=friend_device.id, prekey_id=1).first()
        unclaimed = ChatOneTimePrekey.query.filter_by(chat_device_id=friend_device.id, prekey_id=2).first()
        assert claimed.claimed_at is not None
        assert unclaimed.claimed_at is None
        assert current_user_id != friend_id


def test_e2ee_user_device_bundles_can_skip_prekey_claims(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    _register_user(client, 'e2ee_bundle_skip_me', 'e2ee_bundle_skip_me@example.com')
    friend_id = _register_user(client, 'e2ee_bundle_skip_friend', 'e2ee_bundle_skip_friend@example.com')
    _befriend(client, 'e2ee_bundle_skip_me', 'e2ee_bundle_skip_friend', friend_id)

    _create_chat_device(client.application, friend_id, 'device-friend-skip-001')

    _login_user(client, 'e2ee_bundle_skip_me')
    response = client.get(f'/api/v1/chat/e2ee/users/{friend_id}/device-bundles?claim_prekeys=0')
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['devices'][0]['device_id'] == 'device-friend-skip-001'
    assert 'one_time_prekey' not in payload['devices'][0]

    with client.application.app_context():
        friend_device = ChatDevice.query.filter_by(user_id=friend_id, device_id='device-friend-skip-001').first()
        first_prekey = ChatOneTimePrekey.query.filter_by(chat_device_id=friend_device.id, prekey_id=1).first()
        second_prekey = ChatOneTimePrekey.query.filter_by(chat_device_id=friend_device.id, prekey_id=2).first()
        assert first_prekey.claimed_at is None
        assert second_prekey.claimed_at is None


def test_e2ee_signed_prekey_rotation_replenishment_and_revoke(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    _register_user(client, 'e2ee_rotate_user', 'e2ee_rotate_user@example.com')
    user_id = _login_user(client, 'e2ee_rotate_user')
    _create_chat_device(client.application, user_id, 'device-rotate-001', prekey_count=1)

    with client.session_transaction() as flask_session:
        flask_session['chat_device_id'] = 'device-rotate-001'

    rotate_response = client.post(
        '/api/v1/chat/e2ee/devices/device-rotate-001/signed-prekey',
        json={
            'signed_prekey_id': 555,
            'signed_prekey_public': 'rotated-signed-prekey',
            'signed_prekey_signature': 'rotated-signed-prekey-signature',
        }
    )
    assert rotate_response.status_code == 200, rotate_response.get_json()

    replenish_response = client.post(
        '/api/v1/chat/e2ee/devices/device-rotate-001/one-time-prekeys',
        json={
            'one_time_prekeys': [
                {'prekey_id': 2, 'public_key': 'new-prekey-2'},
                {'prekey_id': 3, 'public_key': 'new-prekey-3'},
            ]
        }
    )
    assert replenish_response.status_code == 200, replenish_response.get_json()
    assert replenish_response.get_json()['inserted_count'] == 2

    revoke_response = client.post('/api/v1/chat/e2ee/devices/device-rotate-001/revoke')
    assert revoke_response.status_code == 200, revoke_response.get_json()

    with client.application.app_context():
        device = ChatDevice.query.filter_by(user_id=user_id, device_id='device-rotate-001').first()
        assert device.status == ChatDeviceStatus.REVOKED
        assert device.transport_identity_mapping is None
        assert all(prekey.claimed_at is not None for prekey in device.one_time_prekeys)


def test_e2ee_conversation_device_bundles_return_member_devices(client, monkeypatch):
    current_user_id = _register_user(client, 'e2ee_conv_me', 'e2ee_conv_me@example.com')
    friend_id = _register_user(client, 'e2ee_conv_friend', 'e2ee_conv_friend@example.com')
    _befriend(client, 'e2ee_conv_me', 'e2ee_conv_friend', friend_id)
    _create_chat_device(client.application, current_user_id, 'device-conv-me-001')
    _create_chat_device(client.application, friend_id, 'device-conv-friend-001')

    _mock_spacetime(
        monkeypatch,
        sql_results_by_match={
            "FROM conversation WHERE conversation_id = 'grp:bundle-room'": [
                {
                    'conversation_id': 'grp:bundle-room',
                    'kind': 'group',
                    'title': 'Bundle Room',
                }
            ],
            "FROM conversation_member WHERE conversation_id = 'grp:bundle-room'": [
                {'user_id': current_user_id},
                {'user_id': friend_id},
            ],
        }
    )

    _login_user(client, 'e2ee_conv_me')
    response = client.get('/api/v1/chat/e2ee/conversations/grp:bundle-room/device-bundles')
    assert response.status_code == 200, response.get_json()
    payload = response.get_json()
    assert payload['conversation_id'] == 'grp:bundle-room'
    assert sorted(member['user_id'] for member in payload['members']) == sorted([current_user_id, friend_id])


def test_e2ee_conversation_device_bundles_can_skip_prekey_claims(client, monkeypatch):
    current_user_id = _register_user(client, 'e2ee_conv_skip_me', 'e2ee_conv_skip_me@example.com')
    friend_id = _register_user(client, 'e2ee_conv_skip_friend', 'e2ee_conv_skip_friend@example.com')
    _befriend(client, 'e2ee_conv_skip_me', 'e2ee_conv_skip_friend', friend_id)
    _create_chat_device(client.application, current_user_id, 'device-conv-skip-me-001')
    _create_chat_device(client.application, friend_id, 'device-conv-skip-friend-001')

    _mock_spacetime(
        monkeypatch,
        sql_results_by_match={
            "FROM conversation WHERE conversation_id = 'grp:bundle-skip-room'": [
                {
                    'conversation_id': 'grp:bundle-skip-room',
                    'kind': 'group',
                    'title': 'Bundle Skip Room',
                }
            ],
            "FROM conversation_member WHERE conversation_id = 'grp:bundle-skip-room'": [
                {'user_id': current_user_id},
                {'user_id': friend_id},
            ],
        }
    )

    _login_user(client, 'e2ee_conv_skip_me')
    response = client.get('/api/v1/chat/e2ee/conversations/grp:bundle-skip-room/device-bundles?claim_prekeys=0')
    assert response.status_code == 200, response.get_json()
    payload = response.get_json()
    friend_entry = next(member for member in payload['members'] if member['user_id'] == friend_id)
    assert friend_entry['devices'][0]['device_id'] == 'device-conv-skip-friend-001'
    assert 'one_time_prekey' not in friend_entry['devices'][0]

    with client.application.app_context():
        friend_device = ChatDevice.query.filter_by(user_id=friend_id, device_id='device-conv-skip-friend-001').first()
        first_prekey = ChatOneTimePrekey.query.filter_by(chat_device_id=friend_device.id, prekey_id=1).first()
        second_prekey = ChatOneTimePrekey.query.filter_by(chat_device_id=friend_device.id, prekey_id=2).first()
        assert first_prekey.claimed_at is None
        assert second_prekey.claimed_at is None
