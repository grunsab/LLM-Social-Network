import base64
import re
import uuid
from itertools import combinations

import requests
from cryptography.fernet import Fernet, InvalidToken
from flask import current_app, request
from flask_login import current_user, login_required
from flask_restful import Resource, abort
from sqlalchemy import and_, or_

from models import (
    ChatIdentityMapping,
    FriendRequest,
    FriendRequestStatus,
    User,
    db,
)


CONVERSATION_ID_RE = re.compile(r"^[A-Za-z0-9:_-]{3,128}$")


class SpacetimeApiError(Exception):
    def __init__(self, message, status_code=None, payload=None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


class SpacetimeHttpClient:
    def __init__(self):
        self.http_url = (current_app.config.get('SPACETIMEDB_HTTP_URL') or '').rstrip('/')
        self.db_name = current_app.config.get('SPACETIMEDB_DB_NAME')
        self.service_token = current_app.config.get('SPACETIMEDB_SERVICE_TOKEN')
        self.timeout_seconds = int(current_app.config.get('SPACETIMEDB_HTTP_TIMEOUT_SECONDS', 15))

    def _require_http_base(self):
        if not self.http_url:
            raise SpacetimeApiError("SPACETIMEDB_HTTP_URL is not configured.")

    def _parse_json(self, response):
        if not response.text:
            return None
        try:
            return response.json()
        except ValueError:
            return None

    def _handle_error(self, response, default_message):
        payload = self._parse_json(response)
        message = default_message
        if isinstance(payload, dict):
            message = (
                payload.get('message')
                or payload.get('error')
                or payload.get('detail')
                or default_message
            )
        raise SpacetimeApiError(message, status_code=response.status_code, payload=payload)

    def _post(self, path, json_payload=None, headers=None):
        self._require_http_base()
        url = f"{self.http_url}{path}"
        response = requests.post(
            url,
            json=json_payload,
            headers=headers or {},
            timeout=self.timeout_seconds,
        )
        return response

    def _service_headers(self):
        if not self.service_token:
            raise SpacetimeApiError("SPACETIMEDB_SERVICE_TOKEN is not configured.")
        return {'Authorization': f'Bearer {self.service_token}'}

    def create_identity(self):
        response = self._post('/v1/identity')
        if response.status_code >= 400:
            self._handle_error(response, "Failed to create SpaceTime identity.")
        payload = self._parse_json(response) or {}
        identity = payload.get('identity')
        token = payload.get('token')
        if not identity or not token:
            raise SpacetimeApiError("SpaceTime identity response is missing identity or token.")
        return {'identity': identity, 'token': token}

    def create_websocket_token(self, identity_token):
        bearer_headers = {'Authorization': f'Bearer {identity_token}'}
        response = self._post('/v1/identity/websocket-token', headers=bearer_headers)
        if response.status_code >= 400:
            basic_auth = base64.b64encode(f"{identity_token}:".encode('utf-8')).decode('utf-8')
            basic_headers = {'Authorization': f'Basic {basic_auth}'}
            response = self._post('/v1/identity/websocket-token', headers=basic_headers)
        if response.status_code >= 400:
            self._handle_error(response, "Failed to create websocket token for SpaceTime identity.")
        payload = self._parse_json(response) or {}
        token = payload.get('token')
        if not token:
            raise SpacetimeApiError("SpaceTime websocket token response is missing token.")
        return token

    def call_reducer(self, reducer_name, args):
        if not self.db_name:
            raise SpacetimeApiError("SPACETIMEDB_DB_NAME is not configured.")
        path = f"/v1/database/{self.db_name}/call/{reducer_name}"
        response = self._post(path, json_payload=args, headers=self._service_headers())
        if response.status_code >= 400:
            self._handle_error(response, f"Failed to call reducer '{reducer_name}'.")
        return self._parse_json(response)

    def run_sql(self, query):
        if not self.db_name:
            raise SpacetimeApiError("SPACETIMEDB_DB_NAME is not configured.")
        path = f"/v1/database/{self.db_name}/sql"
        response = self._post(path, json_payload={'query': query}, headers=self._service_headers())
        if response.status_code >= 400:
            self._handle_error(response, "Failed to execute SpaceTime SQL query.")
        return self._normalize_sql_rows(self._parse_json(response))

    def _normalize_sql_rows(self, payload):
        if payload is None:
            return []
        if isinstance(payload, list):
            return payload
        if not isinstance(payload, dict):
            return []

        if 'rows' in payload:
            rows = payload.get('rows') or []
            columns = payload.get('columns')
            if rows and columns and isinstance(rows[0], list):
                out = []
                for row in rows:
                    out.append({col: row[idx] for idx, col in enumerate(columns)})
                return out
            return rows if isinstance(rows, list) else []

        if 'result' in payload:
            return self._normalize_sql_rows(payload.get('result'))
        if 'data' in payload:
            return self._normalize_sql_rows(payload.get('data'))
        if 'records' in payload:
            return self._normalize_sql_rows(payload.get('records'))
        return []


def _get_fernet():
    key = current_app.config.get('SPACETIMEDB_TOKEN_ENCRYPTION_KEY')
    if not key:
        abort(500, message="SPACETIMEDB_TOKEN_ENCRYPTION_KEY is not configured on the server.")
    try:
        return Fernet(key.encode('utf-8') if isinstance(key, str) else key)
    except Exception:
        abort(500, message="SPACETIMEDB_TOKEN_ENCRYPTION_KEY is invalid.")


def _encrypt_token(token):
    fernet = _get_fernet()
    return fernet.encrypt(token.encode('utf-8')).decode('utf-8')


def _decrypt_token(token_encrypted):
    fernet = _get_fernet()
    try:
        return fernet.decrypt(token_encrypted.encode('utf-8')).decode('utf-8')
    except InvalidToken:
        abort(500, message="Stored SpaceTime token could not be decrypted.")


def _get_or_create_identity_mapping(user, spacetime_client):
    mapping = ChatIdentityMapping.query.filter_by(user_id=user.id).first()
    if mapping:
        token = _decrypt_token(mapping.token_encrypted)
        return mapping, token

    created = spacetime_client.create_identity()
    mapping = ChatIdentityMapping(
        user_id=user.id,
        spacetimedb_identity=created['identity'],
        token_encrypted=_encrypt_token(created['token']),
    )
    db.session.add(mapping)
    db.session.commit()
    return mapping, created['token']


def _ensure_registered_identity(user, spacetime_client):
    mapping, token = _get_or_create_identity_mapping(user, spacetime_client)
    spacetime_client.call_reducer(
        'register_user_identity',
        {
            'user_id': int(user.id),
            'identity': mapping.spacetimedb_identity,
        }
    )
    return mapping, token


def _friend_edges_for_users(user_ids):
    if len(user_ids) < 2:
        return set()
    requests = FriendRequest.query.filter(
        FriendRequest.status == FriendRequestStatus.ACCEPTED,
        or_(
            and_(
                FriendRequest.sender_id.in_(user_ids),
                FriendRequest.receiver_id.in_(user_ids),
            ),
            and_(
                FriendRequest.receiver_id.in_(user_ids),
                FriendRequest.sender_id.in_(user_ids),
            ),
        ),
    ).all()
    edges = set()
    for req in requests:
        edges.add(tuple(sorted((req.sender_id, req.receiver_id))))
    return edges


def _assert_mutual_friendship(user_ids):
    edges = _friend_edges_for_users(user_ids)
    for user_a, user_b in combinations(sorted(set(user_ids)), 2):
        if tuple(sorted((user_a, user_b))) not in edges:
            abort(
                403,
                message=f"Users {user_a} and {user_b} are not accepted friends."
            )


def _conversation_id_safe(conversation_id):
    return bool(CONVERSATION_ID_RE.match(conversation_id or ''))


def _get_conversation_row(spacetime_client, conversation_id):
    rows = spacetime_client.run_sql(
        f"SELECT conversation_id, kind, title FROM conversation WHERE conversation_id = '{conversation_id}' LIMIT 1"
    )
    if not rows:
        return None
    return rows[0]


def _get_conversation_member_ids(spacetime_client, conversation_id):
    rows = spacetime_client.run_sql(
        f"SELECT user_id FROM conversation_member WHERE conversation_id = '{conversation_id}'"
    )
    member_ids = []
    for row in rows:
        value = row.get('user_id') if isinstance(row, dict) else None
        if value is None:
            continue
        try:
            member_ids.append(int(value))
        except (TypeError, ValueError):
            continue
    return sorted(set(member_ids))


class ChatBootstrapResource(Resource):
    @login_required
    def get(self):
        client = SpacetimeHttpClient()
        try:
            mapping, identity_token = _ensure_registered_identity(current_user, client)
            websocket_token = client.create_websocket_token(identity_token)
        except SpacetimeApiError as err:
            abort(
                502,
                message=f"SpaceTime bootstrap failed: {str(err)}"
            )

        ws_url = current_app.config.get('SPACETIMEDB_WS_URL') or 'wss://maincloud.spacetimedb.com'
        return {
            'ws_url': ws_url,
            'db_name': current_app.config.get('SPACETIMEDB_DB_NAME'),
            'db_id': current_app.config.get('SPACETIMEDB_DB_ID'),
            'identity': mapping.spacetimedb_identity,
            'websocket_token': websocket_token,
            'user_id': current_user.id,
        }, 200


class ChatFriendsResource(Resource):
    @login_required
    def get(self):
        friends = current_user.get_friends()
        friends_sorted = sorted(friends, key=lambda user: user.username.lower())
        return [
            {
                'id': friend.id,
                'username': friend.username,
                'profile_picture': friend.profile_picture,
            }
            for friend in friends_sorted
        ], 200


class ChatDMResource(Resource):
    @login_required
    def post(self):
        data = request.get_json(silent=True) or {}
        target_user_id = data.get('user_id')

        if not isinstance(target_user_id, int):
            abort(400, message="`user_id` must be an integer.")

        target_user = db.session.get(User, target_user_id)
        if not target_user:
            abort(404, message="Target user was not found.")
        if target_user.id == current_user.id:
            abort(400, message="You cannot create a direct chat with yourself.")
        if not current_user.is_friend(target_user):
            abort(403, message="Direct chats can only be created between accepted friends.")

        client = SpacetimeHttpClient()
        low_id, high_id = sorted((int(current_user.id), int(target_user.id)))
        conversation_id = f"dm:{low_id}:{high_id}"
        title = f"DM: {current_user.username} & {target_user.username}"

        try:
            _ensure_registered_identity(current_user, client)
            _ensure_registered_identity(target_user, client)
            client.call_reducer(
                'ensure_dm',
                {
                    'conversation_id': conversation_id,
                    'user_a_id': low_id,
                    'user_b_id': high_id,
                    'title': title,
                }
            )
        except SpacetimeApiError as err:
            abort(502, message=f"Failed to create or fetch DM conversation: {str(err)}")

        return {
            'conversation_id': conversation_id,
            'kind': 'dm',
            'title': title,
        }, 200


class ChatGroupResource(Resource):
    @login_required
    def post(self):
        data = request.get_json(silent=True) or {}
        title = data.get('title')
        member_user_ids = data.get('member_user_ids')

        if not isinstance(title, str) or not title.strip():
            abort(400, message="`title` is required and must be a non-empty string.")
        if not isinstance(member_user_ids, list) or not member_user_ids:
            abort(400, message="`member_user_ids` must be a non-empty array of user IDs.")
        if not all(isinstance(user_id, int) for user_id in member_user_ids):
            abort(400, message="`member_user_ids` must contain only integers.")

        participant_ids = sorted(set([int(current_user.id), *member_user_ids]))
        users = User.query.filter(User.id.in_(participant_ids)).all()
        if len(users) != len(participant_ids):
            abort(404, message="One or more requested group members were not found.")
        _assert_mutual_friendship(participant_ids)

        client = SpacetimeHttpClient()
        conversation_id = f"grp:{uuid.uuid4().hex}"

        try:
            for user in users:
                _ensure_registered_identity(user, client)
            client.call_reducer(
                'create_group',
                {
                    'conversation_id': conversation_id,
                    'title': title.strip(),
                    'creator_user_id': int(current_user.id),
                    'member_user_ids': participant_ids,
                }
            )
        except SpacetimeApiError as err:
            abort(502, message=f"Failed to create group conversation: {str(err)}")

        return {
            'conversation_id': conversation_id,
            'kind': 'group',
            'title': title.strip(),
            'member_user_ids': participant_ids,
        }, 201


class ChatGroupMemberResource(Resource):
    @login_required
    def post(self, conversation_id):
        if not _conversation_id_safe(conversation_id):
            abort(400, message="Invalid conversation ID.")

        data = request.get_json(silent=True) or {}
        user_id = data.get('user_id')
        if not isinstance(user_id, int):
            abort(400, message="`user_id` must be an integer.")

        target_user = db.session.get(User, user_id)
        if not target_user:
            abort(404, message="Target user was not found.")

        client = SpacetimeHttpClient()
        try:
            conversation_row = _get_conversation_row(client, conversation_id)
            if not conversation_row:
                abort(404, message="Conversation was not found.")
            if conversation_row.get('kind') != 'group':
                abort(400, message="Members can only be added to group conversations.")

            existing_member_ids = _get_conversation_member_ids(client, conversation_id)
            if int(current_user.id) not in existing_member_ids:
                abort(403, message="You are not a member of this group.")

            if user_id in existing_member_ids:
                return {'message': 'User is already a group member.'}, 200

            _assert_mutual_friendship([*existing_member_ids, user_id])
            _ensure_registered_identity(target_user, client)
            client.call_reducer(
                'add_group_member',
                {
                    'conversation_id': conversation_id,
                    'user_id': int(user_id),
                }
            )
        except SpacetimeApiError as err:
            abort(502, message=f"Failed to add group member: {str(err)}")

        return {
            'conversation_id': conversation_id,
            'user_id': user_id,
            'message': 'Group member added successfully.',
        }, 201
