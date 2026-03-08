import uuid

import resources.chat as chat_module

from models import ChatIdentityMapping, ChatTransportIdentityMapping


def _register_user(client, username, email, password='p'):
    response = client.post(
        '/api/v1/register',
        json={
            'username': username,
            'email': email,
            'password': password,
        }
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()['user_id']


def _login_user(client, identifier, password='p'):
    response = client.post(
        '/api/v1/login',
        json={
            'identifier': identifier,
            'password': password,
        }
    )
    assert response.status_code == 200, response.get_json()
    return response.get_json()['user']['id']


def _logout_user(client):
    client.post('/api/v1/logout')


def _befriend(client, sender_identifier, receiver_identifier, receiver_id):
    _login_user(client, sender_identifier)
    send_response = client.post('/api/v1/friend-requests', json={'user_id': receiver_id})
    assert send_response.status_code == 201, send_response.get_json()
    request_id = send_response.get_json()['id']
    _logout_user(client)

    _login_user(client, receiver_identifier)
    accept_response = client.put(
        f'/api/v1/friend-requests/{request_id}',
        json={'action': 'accept'}
    )
    assert accept_response.status_code == 200, accept_response.get_json()
    _logout_user(client)


def _register_chat_device(client, device_id, label='Primary browser'):
    response = client.post(
        '/api/v1/chat/e2ee/devices',
        json={
            'device_id': device_id,
            'label': label,
            'identity_key_public': f'identity-{device_id}',
            'signing_key_public': f'signing-{device_id}',
            'signed_prekey_id': 101,
            'signed_prekey_public': f'signed-prekey-{device_id}',
            'signed_prekey_signature': f'signed-prekey-signature-{device_id}',
            'one_time_prekeys': [
                {'prekey_id': 1, 'public_key': f'prekey-1-{device_id}'},
            ],
        }
    )
    assert response.status_code == 201, response.get_json()
    return response.get_json()


def _mock_spacetime(monkeypatch, sql_results_by_match=None):
    call_log = {
        'calls': [],
        'created_identities': [],
    }

    def _create_identity(_self):
        token_suffix = uuid.uuid4().hex
        created = {
            'identity': f"0x{token_suffix.rjust(64, '0')}",
            'token': f"identity-token-{token_suffix}",
        }
        call_log['created_identities'].append(created)
        return created

    def _create_websocket_token(_self, identity_token):
        return f"ws-{identity_token}"

    def _call_reducer(_self, reducer_name, args):
        call_log['calls'].append((reducer_name, args))
        return {'ok': True}

    def _run_sql(_self, query):
        call_log['calls'].append(('sql', query))
        if sql_results_by_match:
            for match_text, rows in sql_results_by_match.items():
                if match_text in query:
                    return rows
        return []

    monkeypatch.setattr(chat_module.SpacetimeHttpClient, 'create_identity', _create_identity)
    monkeypatch.setattr(chat_module.SpacetimeHttpClient, 'create_websocket_token', _create_websocket_token)
    monkeypatch.setattr(chat_module.SpacetimeHttpClient, 'call_reducer', _call_reducer)
    monkeypatch.setattr(chat_module.SpacetimeHttpClient, 'run_sql', _run_sql)
    return call_log


def test_chat_bootstrap_requires_auth(client):
    response = client.get('/api/v1/chat/bootstrap')
    assert response.status_code == 401


def test_chat_bootstrap_success_creates_identity_mapping(client, monkeypatch):
    call_log = _mock_spacetime(monkeypatch)
    _register_user(client, 'chat_bootstrap_user', 'chat_bootstrap_user@example.com')
    user_id = _login_user(client, 'chat_bootstrap_user')

    response = client.get('/api/v1/chat/bootstrap')
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['user_id'] == user_id
    assert payload['db_name'] == 'socialnetworkdotsocial-48xhr'
    assert payload['ws_url'] == 'https://maincloud.spacetimedb.com'
    assert payload['websocket_token'].startswith('ws-identity-token-')
    assert payload['identity'].startswith('0x')

    with client.application.app_context():
        mapping = ChatIdentityMapping.query.filter_by(user_id=user_id).first()
        assert mapping is not None
        assert mapping.spacetimedb_identity == payload['identity']
        assert mapping.token_encrypted != f"identity-token-{user_id}"

    register_calls = [entry for entry in call_log['calls'] if entry[0] == 'register_device_identity']
    assert register_calls == [
        (
            'register_device_identity',
            [
                user_id,
                f'legacy-user-{user_id}',
                {'__identity__': payload['identity']},
            ]
        )
    ]


def test_chat_bootstrap_reuses_existing_identity_mapping(client, monkeypatch):
    call_log = _mock_spacetime(monkeypatch)
    _register_user(client, 'chat_bootstrap_repeat', 'chat_bootstrap_repeat@example.com')
    _login_user(client, 'chat_bootstrap_repeat')

    first_response = client.get('/api/v1/chat/bootstrap')
    second_response = client.get('/api/v1/chat/bootstrap')

    assert first_response.status_code == 200
    assert second_response.status_code == 200
    assert first_response.get_json()['identity'] == second_response.get_json()['identity']
    assert len(call_log['created_identities']) == 1


def test_chat_bootstrap_prefers_active_device_transport_identity(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    _register_user(client, 'chat_bootstrap_device', 'chat_bootstrap_device@example.com')
    user_id = _login_user(client, 'chat_bootstrap_device')

    registration_response = client.post(
        '/api/v1/chat/e2ee/devices',
        json={
            'device_id': 'device-bootstrap-001',
            'label': 'Primary browser',
            'identity_key_public': 'identity-device-bootstrap-001',
            'signing_key_public': 'signing-device-bootstrap-001',
            'signed_prekey_id': 101,
            'signed_prekey_public': 'signed-prekey-device-bootstrap-001',
            'signed_prekey_signature': 'signed-prekey-signature-device-bootstrap-001',
            'one_time_prekeys': [
                {'prekey_id': 1, 'public_key': 'prekey-1-device-bootstrap-001'},
            ],
        }
    )
    assert registration_response.status_code == 201, registration_response.get_json()

    bootstrap_response = client.get('/api/v1/chat/bootstrap')
    assert bootstrap_response.status_code == 200, bootstrap_response.get_json()
    payload = bootstrap_response.get_json()
    assert payload['device_id'] == 'device-bootstrap-001'

    with client.application.app_context():
        legacy_mapping = ChatIdentityMapping.query.filter_by(user_id=user_id).first()
        device_mapping = ChatTransportIdentityMapping.query.filter_by(user_id=user_id).first()
        assert legacy_mapping is None
        assert device_mapping is not None
        assert device_mapping.spacetimedb_identity == payload['identity']


def test_chat_bootstrap_falls_back_to_db_id_when_name_missing(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    _register_user(client, 'chat_bootstrap_db_id', 'chat_bootstrap_db_id@example.com')
    _login_user(client, 'chat_bootstrap_db_id')

    original_db_name = client.application.config['SPACETIMEDB_DB_NAME']
    client.application.config['SPACETIMEDB_DB_NAME'] = None
    try:
        response = client.get('/api/v1/chat/bootstrap')
        assert response.status_code == 200
        payload = response.get_json()
        assert payload['db_name'] == 'c20069a056fa0538d26edbfe04785fe43b106f2fd5721f4a6555cf67f4090f93'
        assert payload['db_id'] == 'c20069a056fa0538d26edbfe04785fe43b106f2fd5721f4a6555cf67f4090f93'
    finally:
        client.application.config['SPACETIMEDB_DB_NAME'] = original_db_name


def test_chat_dm_requires_friendship(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    _register_user(client, 'chat_dm_sender', 'chat_dm_sender@example.com')
    target_id = _register_user(client, 'chat_dm_target', 'chat_dm_target@example.com')
    _login_user(client, 'chat_dm_sender')

    response = client.post('/api/v1/chat/dm', json={'user_id': target_id})
    assert response.status_code == 403
    assert 'accepted friends' in response.get_json()['message']


def test_chat_dm_success_for_friends(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    user_a_id = _register_user(client, 'chat_dm_friend_a', 'chat_dm_friend_a@example.com')
    user_b_id = _register_user(client, 'chat_dm_friend_b', 'chat_dm_friend_b@example.com')
    _befriend(client, 'chat_dm_friend_a', 'chat_dm_friend_b', user_b_id)

    _login_user(client, 'chat_dm_friend_a')
    response = client.post('/api/v1/chat/dm', json={'user_id': user_b_id})
    assert response.status_code == 200

    payload = response.get_json()
    low, high = sorted((user_a_id, user_b_id))
    assert payload['conversation_id'] == f'dm:{low}:{high}'
    assert payload['kind'] == 'dm'


def test_chat_dm_rejects_encrypted_creation_when_rollout_is_disabled(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    user_a_id = _register_user(client, 'chat_dm_rollout_a', 'chat_dm_rollout_a@example.com')
    user_b_id = _register_user(client, 'chat_dm_rollout_b', 'chat_dm_rollout_b@example.com')
    _befriend(client, 'chat_dm_rollout_a', 'chat_dm_rollout_b', user_b_id)

    client.application.config['CHAT_E2EE_NEW_CONVERSATIONS_ENABLED'] = False
    try:
        _login_user(client, 'chat_dm_rollout_a')
        response = client.post('/api/v1/chat/dm', json={
            'user_id': user_b_id,
            'encryption_mode': 'e2ee_v1',
        })
    finally:
        client.application.config['CHAT_E2EE_NEW_CONVERSATIONS_ENABLED'] = True

    assert response.status_code == 403
    assert 'currently disabled for rollout' in response.get_json()['message']


def test_chat_dm_rejects_encrypted_creation_when_participant_has_no_device(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    _register_user(client, 'chat_dm_ready_a', 'chat_dm_ready_a@example.com')
    user_b_id = _register_user(client, 'chat_dm_ready_b', 'chat_dm_ready_b@example.com')
    _befriend(client, 'chat_dm_ready_a', 'chat_dm_ready_b', user_b_id)

    _login_user(client, 'chat_dm_ready_a')
    _register_chat_device(client, 'device-dm-ready-a')

    response = client.post('/api/v1/chat/dm', json={
        'user_id': user_b_id,
        'encryption_mode': 'e2ee_v1',
    })

    assert response.status_code == 409
    assert 'Missing active devices for user IDs' in response.get_json()['message']
    assert str(user_b_id) in response.get_json()['message']


def test_group_create_requires_mutual_friendships(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    user_a_id = _register_user(client, 'chat_group_a', 'chat_group_a@example.com')
    user_b_id = _register_user(client, 'chat_group_b', 'chat_group_b@example.com')
    user_c_id = _register_user(client, 'chat_group_c', 'chat_group_c@example.com')

    _befriend(client, 'chat_group_a', 'chat_group_b', user_b_id)
    _befriend(client, 'chat_group_a', 'chat_group_c', user_c_id)

    _login_user(client, 'chat_group_a')
    response = client.post(
        '/api/v1/chat/groups',
        json={
            'title': 'Mutual group',
            'member_user_ids': [user_b_id, user_c_id],
        }
    )
    assert response.status_code == 403
    assert 'not accepted friends' in response.get_json()['message']


def test_chat_friends_returns_only_accepted_friends_sorted(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    _register_user(client, 'chat_friends_owner', 'chat_friends_owner@example.com')
    friend_zed_id = _register_user(client, 'zed_friend', 'zed_friend@example.com')
    friend_amy_id = _register_user(client, 'amy_friend', 'amy_friend@example.com')
    pending_id = _register_user(client, 'pending_friend', 'pending_friend@example.com')

    _befriend(client, 'chat_friends_owner', 'zed_friend', friend_zed_id)
    _befriend(client, 'chat_friends_owner', 'amy_friend', friend_amy_id)

    _login_user(client, 'chat_friends_owner')
    pending_response = client.post('/api/v1/friend-requests', json={'user_id': pending_id})
    assert pending_response.status_code == 201, pending_response.get_json()

    response = client.get('/api/v1/chat/friends')
    assert response.status_code == 200

    payload = response.get_json()
    assert [row['username'] for row in payload] == ['amy_friend', 'zed_friend']


def test_group_create_success_registers_members_and_calls_reducer(client, monkeypatch):
    call_log = _mock_spacetime(monkeypatch)
    user_a_id = _register_user(client, 'chat_group_success_a', 'chat_group_success_a@example.com')
    user_b_id = _register_user(client, 'chat_group_success_b', 'chat_group_success_b@example.com')
    user_c_id = _register_user(client, 'chat_group_success_c', 'chat_group_success_c@example.com')

    _befriend(client, 'chat_group_success_a', 'chat_group_success_b', user_b_id)
    _befriend(client, 'chat_group_success_a', 'chat_group_success_c', user_c_id)
    _befriend(client, 'chat_group_success_b', 'chat_group_success_c', user_c_id)

    _login_user(client, 'chat_group_success_a')
    response = client.post(
        '/api/v1/chat/groups',
        json={
            'title': 'Triplet',
            'member_user_ids': [user_b_id, user_c_id],
        }
    )

    assert response.status_code == 201
    payload = response.get_json()
    assert payload['kind'] == 'group'
    assert payload['member_user_ids'] == sorted([user_a_id, user_b_id, user_c_id])
    assert payload['conversation_id'].startswith('grp:')

    reducer_calls = [entry for entry in call_log['calls'] if entry[0] != 'sql']
    register_calls = [entry for entry in reducer_calls if entry[0] == 'register_device_identity']
    create_group_calls = [entry for entry in reducer_calls if entry[0] == 'create_group']

    assert register_calls == []
    assert len(create_group_calls) == 1
    assert create_group_calls[0][1][2] == user_a_id
    assert create_group_calls[0][1][3] == sorted([user_a_id, user_b_id, user_c_id])
    assert create_group_calls[0][1][4] == 'legacy'


def test_group_create_rejects_encrypted_members_without_devices(client, monkeypatch):
    _mock_spacetime(monkeypatch)
    user_a_id = _register_user(client, 'chat_group_e2ee_a', 'chat_group_e2ee_a@example.com')
    user_b_id = _register_user(client, 'chat_group_e2ee_b', 'chat_group_e2ee_b@example.com')

    _befriend(client, 'chat_group_e2ee_a', 'chat_group_e2ee_b', user_b_id)

    _login_user(client, 'chat_group_e2ee_a')
    _register_chat_device(client, 'device-group-ready-a')

    response = client.post(
        '/api/v1/chat/groups',
        json={
            'title': 'Encrypted Group',
            'member_user_ids': [user_b_id],
            'encryption_mode': 'e2ee_v1',
        }
    )

    assert response.status_code == 409
    assert 'Missing active devices for user IDs' in response.get_json()['message']
    assert str(user_b_id) in response.get_json()['message']


def test_group_member_add_success_requires_existing_membership(client, monkeypatch):
    user_a_id = _register_user(client, 'chat_group_add_a', 'chat_group_add_a@example.com')
    user_b_id = _register_user(client, 'chat_group_add_b', 'chat_group_add_b@example.com')
    user_c_id = _register_user(client, 'chat_group_add_c', 'chat_group_add_c@example.com')

    _befriend(client, 'chat_group_add_a', 'chat_group_add_b', user_b_id)
    _befriend(client, 'chat_group_add_a', 'chat_group_add_c', user_c_id)
    _befriend(client, 'chat_group_add_b', 'chat_group_add_c', user_c_id)

    call_log = _mock_spacetime(
        monkeypatch,
        sql_results_by_match={
            "FROM conversation WHERE conversation_id = 'grp:test-room'": [
                {
                    'conversation_id': 'grp:test-room',
                    'kind': 'group',
                    'title': 'Test Room',
                }
            ],
            "FROM conversation_member WHERE conversation_id = 'grp:test-room'": [
                {'user_id': user_a_id},
                {'user_id': user_b_id},
            ],
        }
    )

    _login_user(client, 'chat_group_add_a')
    response = client.post(
        '/api/v1/chat/groups/grp:test-room/members',
        json={'user_id': user_c_id}
    )

    assert response.status_code == 201
    payload = response.get_json()
    assert payload['conversation_id'] == 'grp:test-room'
    assert payload['user_id'] == user_c_id

    add_member_calls = [entry for entry in call_log['calls'] if entry[0] == 'add_group_member']
    assert add_member_calls == [
        (
            'add_group_member',
            [
                'grp:test-room',
                user_c_id,
                user_a_id,
                None,
            ]
        )
    ]


def test_group_member_add_rejects_encrypted_member_without_device(client, monkeypatch):
    user_a_id = _register_user(client, 'chat_group_e2ee_add_a', 'chat_group_e2ee_add_a@example.com')
    user_b_id = _register_user(client, 'chat_group_e2ee_add_b', 'chat_group_e2ee_add_b@example.com')
    user_c_id = _register_user(client, 'chat_group_e2ee_add_c', 'chat_group_e2ee_add_c@example.com')

    _befriend(client, 'chat_group_e2ee_add_a', 'chat_group_e2ee_add_b', user_b_id)
    _befriend(client, 'chat_group_e2ee_add_a', 'chat_group_e2ee_add_c', user_c_id)
    _befriend(client, 'chat_group_e2ee_add_b', 'chat_group_e2ee_add_c', user_c_id)

    call_log = _mock_spacetime(
        monkeypatch,
        sql_results_by_match={
            "FROM conversation WHERE conversation_id = 'grp:e2ee-room'": [
                {
                    'conversation_id': 'grp:e2ee-room',
                    'kind': 'group',
                    'title': 'Encrypted Room',
                    'encryption_mode': 'e2ee_v1',
                }
            ],
            "FROM conversation_member WHERE conversation_id = 'grp:e2ee-room'": [
                {'user_id': user_a_id},
                {'user_id': user_b_id},
            ],
        }
    )

    _login_user(client, 'chat_group_e2ee_add_a')
    _register_chat_device(client, 'device-group-add-a')

    response = client.post(
        '/api/v1/chat/groups/grp:e2ee-room/members',
        json={'user_id': user_c_id}
    )

    assert response.status_code == 409
    assert 'active chat device' in response.get_json()['message']
    add_member_calls = [entry for entry in call_log['calls'] if entry[0] == 'add_group_member']
    assert add_member_calls == []
