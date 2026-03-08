import base64
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from itertools import combinations
from urllib.parse import quote

import requests
from cryptography.fernet import Fernet, InvalidToken
from flask import current_app, request, session
from flask_login import current_user, login_required
from flask_restful import Resource, abort
from sqlalchemy import and_, or_
from werkzeug.security import check_password_hash, generate_password_hash

from models import (
    ChatDevice,
    ChatDeviceKind,
    ChatDeviceLinkSession,
    ChatDeviceLinkSessionStatus,
    ChatDeviceStatus,
    ChatIdentityMapping,
    ChatOneTimePrekey,
    ChatTransportIdentityMapping,
    FriendRequest,
    FriendRequestStatus,
    User,
    db,
)


CONVERSATION_ID_RE = re.compile(r"^[A-Za-z0-9:_-]{3,128}$")
DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9:_-]{3,64}$")
LEGACY_ENCRYPTION_MODE = 'legacy'
E2EE_ENCRYPTION_MODE = 'e2ee_v1'


class SpacetimeApiError(Exception):
    def __init__(self, message, status_code=None, payload=None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload


class SpacetimeHttpClient:
    def __init__(self):
        self.http_url = (current_app.config.get('SPACETIMEDB_HTTP_URL') or '').rstrip('/')
        self.db_name = current_app.config.get('SPACETIMEDB_DB_NAME')
        self.db_id = current_app.config.get('SPACETIMEDB_DB_ID')
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
        elif isinstance(payload, str) and payload.strip():
            message = payload.strip()
        elif response.text:
            message = response.text.strip() or default_message
        raise SpacetimeApiError(message, status_code=response.status_code, payload=payload)

    def _db_identifier(self):
        identifier = self.db_name or self.db_id
        if not identifier:
            raise SpacetimeApiError("Neither SPACETIMEDB_DB_NAME nor SPACETIMEDB_DB_ID is configured.")
        return quote(identifier, safe='')

    def _post(self, path, json_payload=None, data_payload=None, headers=None):
        self._require_http_base()
        url = f"{self.http_url}{path}"
        try:
            return requests.post(
                url,
                json=json_payload,
                data=data_payload,
                headers=headers or {},
                timeout=self.timeout_seconds,
            )
        except requests.RequestException as err:
            raise SpacetimeApiError(f"Failed to reach SpaceTimeDB: {str(err)}") from err

    def _service_headers(self):
        if not self.service_token:
            raise SpacetimeApiError("SPACETIMEDB_SERVICE_TOKEN is not configured.")
        return {'Authorization': f'Bearer {self.service_token}'}

    def create_identity(self):
        response = self._post('/v1/identity')
        if response.status_code >= 400:
            self._handle_error(response, "Failed to create SpaceTime identity.")
        payload = self._parse_json(response) or {}
        identity = payload.get('identity') if isinstance(payload, dict) else None
        token = payload.get('token') if isinstance(payload, dict) else None
        if not identity or not token:
            raise SpacetimeApiError("SpaceTime identity response is missing identity or token.")
        return {'identity': identity, 'token': token}

    def create_websocket_token(self, identity_token):
        basic_auth = base64.b64encode(f"{identity_token}:".encode('utf-8')).decode('utf-8')
        basic_headers = {'Authorization': f'Basic {basic_auth}'}
        response = self._post('/v1/identity/websocket-token', headers=basic_headers)
        if response.status_code >= 400:
            bearer_headers = {'Authorization': f'Bearer {identity_token}'}
            response = self._post('/v1/identity/websocket-token', headers=bearer_headers)
        if response.status_code >= 400:
            self._handle_error(response, "Failed to create websocket token for SpaceTime identity.")
        payload = self._parse_json(response)
        if isinstance(payload, dict):
            token = payload.get('token')
        elif isinstance(payload, str):
            token = payload.strip().strip('"')
        else:
            token = response.text.strip().strip('"') if response.text else None
        if not token:
            raise SpacetimeApiError("SpaceTime websocket token response is missing token.")
        return token

    def call_reducer(self, reducer_name, args):
        path = f"/v1/database/{self._db_identifier()}/call/{quote(reducer_name, safe='')}"
        if isinstance(args, (list, tuple)):
            payload = list(args)
        else:
            payload = [args]
        response = self._post(path, json_payload=payload, headers=self._service_headers())
        if response.status_code >= 400:
            self._handle_error(response, f"Failed to call reducer '{reducer_name}'.")
        return self._parse_json(response)

    def run_sql(self, query):
        path = f"/v1/database/{self._db_identifier()}/sql"
        headers = {
            **self._service_headers(),
            'Content-Type': 'text/plain; charset=utf-8',
        }
        response = self._post(path, data_payload=query, headers=headers)
        if response.status_code >= 400:
            self._handle_error(response, "Failed to execute SpaceTime SQL query.")
        return self._normalize_sql_rows(self._parse_json(response))

    def _normalize_sql_rows(self, payload):
        if payload is None:
            return []
        if isinstance(payload, list):
            # The SQL HTTP API returns an array of statement results.
            flattened_rows = []
            for statement in payload:
                flattened_rows.extend(self._normalize_sql_statement(statement))
            return flattened_rows
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

    def _normalize_sql_statement(self, statement):
        if not isinstance(statement, dict):
            return []

        rows = statement.get('rows') or []
        schema = statement.get('schema') or {}
        columns = self._schema_column_names(schema)

        if not isinstance(rows, list):
            return []

        normalized = []
        for row in rows:
            if isinstance(row, dict):
                normalized.append(row)
                continue
            if isinstance(row, list) and columns:
                normalized.append({
                    column_name: row[idx] if idx < len(row) else None
                    for idx, column_name in enumerate(columns)
                })
                continue
            normalized.append(row)
        return normalized

    def _schema_column_names(self, schema):
        if not isinstance(schema, dict):
            return []

        if 'Product' in schema and isinstance(schema.get('Product'), dict):
            schema = schema.get('Product') or {}

        elements = schema.get('elements')
        if not isinstance(elements, list):
            return []

        column_names = []
        for index, element in enumerate(elements):
            column_name = None
            if isinstance(element, dict):
                name = element.get('name')
                if isinstance(name, str):
                    column_name = name
                elif isinstance(name, dict):
                    column_name = (
                        name.get('some')
                        or name.get('Some')
                        or name.get('value')
                    )
            column_names.append(column_name or f'col_{index}')
        return column_names


def _normalize_spacetimedb_client_uri(raw_uri):
    if not raw_uri:
        return 'https://maincloud.spacetimedb.com'

    trimmed = raw_uri.rstrip('/')
    if trimmed.startswith('wss://'):
        return f"https://{trimmed[len('wss://'):]}"
    if trimmed.startswith('ws://'):
        return f"http://{trimmed[len('ws://'):]}"
    return trimmed


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


def _normalize_identity_hex(identity_value):
    if not isinstance(identity_value, str) or not identity_value.strip():
        raise SpacetimeApiError("SpaceTime identity is missing or invalid.")

    normalized = identity_value.strip()
    if not normalized.startswith('0x'):
        normalized = f"0x{normalized}"
    return normalized


def _identity_http_arg(identity_value):
    return {
        '__identity__': _normalize_identity_hex(identity_value),
    }


def _now_utc():
    return datetime.now(timezone.utc)


def _chat_min_one_time_prekeys():
    return int(current_app.config.get('CHAT_MIN_ONE_TIME_PREKEYS', 10))


def _chat_device_session_key():
    return 'chat_device_id'


def _chat_e2ee_enabled():
    return bool(current_app.config.get('CHAT_E2EE_ENABLED', True))


def _chat_e2ee_new_conversations_enabled():
    return bool(current_app.config.get('CHAT_E2EE_NEW_CONVERSATIONS_ENABLED', False))


def _serialize_datetime(value):
    if not value:
        return None
    if hasattr(value, 'isoformat'):
        return value.isoformat()
    return value


def _sanitize_device_id(device_id):
    if not isinstance(device_id, str) or not DEVICE_ID_RE.match(device_id.strip()):
        abort(400, message="`device_id` must be a 3-64 character string containing only letters, numbers, `_`, `-`, or `:`.")
    return device_id.strip()


def _require_non_empty_string(data, field_name):
    value = data.get(field_name)
    if not isinstance(value, str) or not value.strip():
        abort(400, message=f"`{field_name}` is required and must be a non-empty string.")
    return value.strip()


def _require_integer(data, field_name):
    value = data.get(field_name)
    if not isinstance(value, int):
        abort(400, message=f"`{field_name}` must be an integer.")
    return value


def _parse_encryption_mode(data, default=LEGACY_ENCRYPTION_MODE):
    value = data.get('encryption_mode')
    if value is None:
        return default
    if not isinstance(value, str):
        abort(400, message="`encryption_mode` must be a string when provided.")
    normalized = value.strip()
    if normalized not in {LEGACY_ENCRYPTION_MODE, E2EE_ENCRYPTION_MODE}:
        abort(400, message="`encryption_mode` must be either `legacy` or `e2ee_v1`.")
    return normalized


def _parse_query_bool(arg_name, default=None):
    raw_value = request.args.get(arg_name)
    if raw_value is None:
        return default

    normalized = raw_value.strip().lower()
    if normalized in {'1', 'true', 'yes', 'on'}:
        return True
    if normalized in {'0', 'false', 'no', 'off'}:
        return False
    abort(400, message=f"`{arg_name}` must be a boolean query parameter when provided.")


def _preferred_request_device_id():
    raw_value = request.args.get('preferred_device_id')
    if not isinstance(raw_value, str):
        return None
    normalized = raw_value.strip()
    if not normalized or not DEVICE_ID_RE.match(normalized):
        return None
    return normalized


def _parse_device_payload(data):
    if not isinstance(data, dict):
        abort(400, message="Request body must be a JSON object.")

    label = data.get('label')
    if label is not None and not isinstance(label, str):
        abort(400, message="`label` must be a string when provided.")

    return {
        'device_id': _sanitize_device_id(data.get('device_id')),
        'label': label.strip() if isinstance(label, str) and label.strip() else None,
        'identity_key_public': _require_non_empty_string(data, 'identity_key_public'),
        'signing_key_public': _require_non_empty_string(data, 'signing_key_public'),
        'signed_prekey_id': _require_integer(data, 'signed_prekey_id'),
        'signed_prekey_public': _require_non_empty_string(data, 'signed_prekey_public'),
        'signed_prekey_signature': _require_non_empty_string(data, 'signed_prekey_signature'),
    }


def _parse_one_time_prekeys(data, field_name='one_time_prekeys'):
    raw_value = data.get(field_name)
    if not isinstance(raw_value, list) or not raw_value:
        abort(400, message=f"`{field_name}` must be a non-empty array.")

    out = []
    seen = set()
    for index, item in enumerate(raw_value):
        if not isinstance(item, dict):
            abort(400, message=f"`{field_name}[{index}]` must be an object.")
        prekey_id = item.get('prekey_id')
        public_key = item.get('public_key')
        if not isinstance(prekey_id, int):
            abort(400, message=f"`{field_name}[{index}].prekey_id` must be an integer.")
        if prekey_id in seen:
            abort(400, message=f"`{field_name}` contains duplicate `prekey_id` values.")
        if not isinstance(public_key, str) or not public_key.strip():
            abort(400, message=f"`{field_name}[{index}].public_key` must be a non-empty string.")
        seen.add(prekey_id)
        out.append({
            'prekey_id': prekey_id,
            'public_key': public_key.strip(),
        })
    return out


def _active_chat_devices_for_user(user_id):
    return ChatDevice.query.filter_by(
        user_id=user_id,
        status=ChatDeviceStatus.ACTIVE,
    ).order_by(ChatDevice.id.asc()).all()


def _missing_active_chat_device_user_ids(user_ids):
    normalized_user_ids = sorted({int(user_id) for user_id in user_ids if user_id is not None})
    if not normalized_user_ids:
        return []

    rows = db.session.query(ChatDevice.user_id).filter(
        ChatDevice.status == ChatDeviceStatus.ACTIVE,
        ChatDevice.user_id.in_(normalized_user_ids),
    ).distinct().all()
    user_ids_with_devices = {int(row[0]) for row in rows}
    return [user_id for user_id in normalized_user_ids if user_id not in user_ids_with_devices]


def _assert_encrypted_conversation_creation_allowed(participant_ids):
    if not _chat_e2ee_enabled():
        abort(403, message="End-to-end encrypted chat is disabled.")
    if not _chat_e2ee_new_conversations_enabled():
        abort(403, message="New end-to-end encrypted conversations are currently disabled for rollout.")

    missing_user_ids = _missing_active_chat_device_user_ids(participant_ids)
    if missing_user_ids:
        missing_text = ', '.join(str(user_id) for user_id in missing_user_ids)
        abort(
            409,
            message=(
                "Encrypted chat requires an active chat device for every participant. "
                f"Missing active devices for user IDs: {missing_text}."
            ),
        )


def _assert_encrypted_group_member_ready(user_id):
    missing_user_ids = _missing_active_chat_device_user_ids([user_id])
    if missing_user_ids:
        abort(
            409,
            message=(
                "Encrypted groups can only add members who already have an active chat device. "
                f"Missing active devices for user ID: {missing_user_ids[0]}."
            ),
        )


def _current_chat_device(auto_select=False):
    device_id = session.get(_chat_device_session_key())
    if device_id:
        device = ChatDevice.query.filter_by(user_id=current_user.id, device_id=device_id).first()
        if device and device.status == ChatDeviceStatus.ACTIVE:
            return device
        session.pop(_chat_device_session_key(), None)

    if auto_select:
        preferred_device_id = _preferred_request_device_id()
        if preferred_device_id:
            preferred_device = ChatDevice.query.filter_by(
                user_id=current_user.id,
                device_id=preferred_device_id,
            ).first()
            if preferred_device and preferred_device.status == ChatDeviceStatus.ACTIVE:
                session[_chat_device_session_key()] = preferred_device.device_id
                return preferred_device
    return None


def _require_current_chat_device():
    device = _current_chat_device(auto_select=True)
    if not device:
        abort(409, message="No active chat device is selected for this session.")
    return device


def _device_by_user_and_id(user_id, device_id):
    return ChatDevice.query.filter_by(user_id=user_id, device_id=device_id).first()


def _serialize_device_summary(device):
    return {
        'device_id': device.device_id,
        'label': device.label,
        'device_kind': device.device_kind.value,
        'status': device.status.value,
        'linked_at': _serialize_datetime(device.linked_at),
        'last_seen_at': _serialize_datetime(device.last_seen_at),
        'approved_by_device_id': device.approved_by_device_id,
    }


def _count_available_one_time_prekeys(device):
    return ChatOneTimePrekey.query.filter_by(
        chat_device_id=device.id,
        claimed_at=None,
    ).count()


def _claim_one_time_prekey(device, claim=True):
    prekey = ChatOneTimePrekey.query.filter_by(
        chat_device_id=device.id,
        claimed_at=None,
    ).order_by(ChatOneTimePrekey.id.asc()).first()
    if not prekey:
        return None
    if claim:
        prekey.claimed_at = _now_utc()
    return {
        'prekey_id': prekey.prekey_id,
        'public_key': prekey.public_key,
    }


def _serialize_device_bundle(device, claim_prekey=False):
    bundle = {
        **_serialize_device_summary(device),
        'identity_key_public': device.identity_key_public,
        'signing_key_public': device.signing_key_public,
        'signed_prekey_id': device.signed_prekey_id,
        'signed_prekey_public': device.signed_prekey_public,
        'signed_prekey_signature': device.signed_prekey_signature,
    }
    if claim_prekey:
        claimed_prekey = _claim_one_time_prekey(device, claim=True)
        if claimed_prekey:
            bundle['one_time_prekey'] = claimed_prekey
    return bundle


def _store_one_time_prekeys(chat_device, prekeys):
    existing_ids = {
        row.prekey_id
        for row in ChatOneTimePrekey.query.with_entities(ChatOneTimePrekey.prekey_id).filter_by(chat_device_id=chat_device.id).all()
    }
    inserted = 0
    for prekey in prekeys:
        if prekey['prekey_id'] in existing_ids:
            continue
        db.session.add(ChatOneTimePrekey(
            chat_device_id=chat_device.id,
            prekey_id=prekey['prekey_id'],
            public_key=prekey['public_key'],
        ))
        existing_ids.add(prekey['prekey_id'])
        inserted += 1
    return inserted


def _generate_approval_code():
    return secrets.token_hex(4).upper()


def _ensure_pending_link_session(link_session):
    if link_session.status != ChatDeviceLinkSessionStatus.PENDING:
        abort(409, message=f"Link session is already {link_session.status.value}.")
    expires_at = link_session.expires_at
    now = _now_utc()
    if expires_at and expires_at.tzinfo is None:
        now = now.replace(tzinfo=None)
    if expires_at and expires_at <= now:
        link_session.status = ChatDeviceLinkSessionStatus.EXPIRED
        db.session.commit()
        abort(410, message="Link session has expired.")


def _ensure_device_transport_identity(chat_device, user, spacetime_client):
    mapping = ChatTransportIdentityMapping.query.filter_by(chat_device_id=chat_device.id).first()
    if mapping:
        return mapping

    created = spacetime_client.create_identity()
    mapping = ChatTransportIdentityMapping(
        chat_device_id=chat_device.id,
        user_id=user.id,
        spacetimedb_identity=created['identity'],
        token_encrypted=_encrypt_token(created['token']),
    )
    db.session.add(mapping)
    db.session.flush()
    return mapping


def _get_or_create_device_transport_identity(chat_device, user, spacetime_client):
    mapping = ChatTransportIdentityMapping.query.filter_by(chat_device_id=chat_device.id).first()
    if mapping:
        token = _decrypt_token(mapping.token_encrypted)
        return mapping, token

    created = spacetime_client.create_identity()
    mapping = ChatTransportIdentityMapping(
        chat_device_id=chat_device.id,
        user_id=user.id,
        spacetimedb_identity=created['identity'],
        token_encrypted=_encrypt_token(created['token']),
    )
    db.session.add(mapping)
    db.session.commit()
    return mapping, created['token']


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


def _legacy_transport_device_id(user_id):
    return f"legacy-user-{int(user_id)}"


def _ensure_registered_identity(user, spacetime_client, chat_device=None):
    selected_device = chat_device
    if (
        selected_device is None
        and getattr(current_user, 'is_authenticated', False)
        and getattr(current_user, 'id', None) == user.id
    ):
        selected_device = _current_chat_device(auto_select=True)

    if selected_device:
        mapping, token = _get_or_create_device_transport_identity(selected_device, user, spacetime_client)
        reducer_device_id = selected_device.device_id
    else:
        mapping, token = _get_or_create_identity_mapping(user, spacetime_client)
        reducer_device_id = _legacy_transport_device_id(user.id)

    spacetime_client.call_reducer(
        'register_device_identity',
        [
            int(user.id),
            reducer_device_id,
            _identity_http_arg(mapping.spacetimedb_identity),
        ]
    )
    return mapping, token, reducer_device_id


def _emit_device_roster_change(spacetime_client, user_id, device_id, change_type, actor_user_id, actor_device_id=None):
    spacetime_client.call_reducer(
        'emit_device_roster_change',
        [
            int(user_id),
            device_id,
            change_type,
            int(actor_user_id),
            actor_device_id,
        ]
    )


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
        f"SELECT conversation_id, kind, title, encryption_mode, current_epoch FROM conversation WHERE conversation_id = '{conversation_id}' LIMIT 1"
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
        current_chat_device = _current_chat_device(auto_select=True)
        try:
            mapping, identity_token, _transport_device_id = _ensure_registered_identity(
                current_user,
                client,
                chat_device=current_chat_device,
            )
            websocket_token = client.create_websocket_token(identity_token)
        except SpacetimeApiError as err:
            abort(
                502,
                message=f"SpaceTime bootstrap failed: {str(err)}"
            )
        except Exception as err:
            current_app.logger.exception("Unexpected chat bootstrap failure")
            abort(
                500,
                message=f"Unexpected chat bootstrap error: {str(err)}"
            )

        ws_url = _normalize_spacetimedb_client_uri(
            current_app.config.get('SPACETIMEDB_WS_URL')
            or current_app.config.get('SPACETIMEDB_HTTP_URL')
        )
        return {
            'ws_url': ws_url,
            'db_name': current_app.config.get('SPACETIMEDB_DB_NAME') or current_app.config.get('SPACETIMEDB_DB_ID'),
            'db_id': current_app.config.get('SPACETIMEDB_DB_ID') or current_app.config.get('SPACETIMEDB_DB_NAME'),
            'identity': mapping.spacetimedb_identity,
            'websocket_token': websocket_token,
            'user_id': current_user.id,
            'device_id': current_chat_device.device_id if current_chat_device else None,
        }, 200


class ChatE2EEBootstrapResource(Resource):
    @login_required
    def get(self):
        current_device = _current_chat_device(auto_select=True)
        active_devices = _active_chat_devices_for_user(current_user.id)
        return {
            'enabled': _chat_e2ee_enabled(),
            'new_conversations_enabled': _chat_e2ee_new_conversations_enabled(),
            'current_device_id': current_device.device_id if current_device else None,
            'has_active_device': len(active_devices) > 0,
            'devices': [_serialize_device_summary(device) for device in active_devices],
            'remaining_one_time_prekeys': _count_available_one_time_prekeys(current_device) if current_device else 0,
            'min_one_time_prekeys': _chat_min_one_time_prekeys(),
        }, 200


class ChatE2EEDeviceRegistrationResource(Resource):
    @login_required
    def post(self):
        if not _chat_e2ee_enabled():
            abort(403, message="End-to-end encrypted chat is disabled.")

        active_devices = _active_chat_devices_for_user(current_user.id)
        if active_devices:
            abort(409, message="An active chat device already exists. Use the device-link flow instead.")

        data = request.get_json(silent=True) or {}
        device_payload = _parse_device_payload(data)
        prekeys = _parse_one_time_prekeys(data)

        if _device_by_user_and_id(current_user.id, device_payload['device_id']):
            abort(409, message="A chat device with this `device_id` already exists for the current user.")

        chat_device = ChatDevice(
            user_id=current_user.id,
            device_id=device_payload['device_id'],
            label=device_payload['label'],
            device_kind=ChatDeviceKind.PRIMARY,
            status=ChatDeviceStatus.ACTIVE,
            identity_key_public=device_payload['identity_key_public'],
            signing_key_public=device_payload['signing_key_public'],
            signed_prekey_id=device_payload['signed_prekey_id'],
            signed_prekey_public=device_payload['signed_prekey_public'],
            signed_prekey_signature=device_payload['signed_prekey_signature'],
            linked_at=_now_utc(),
            last_seen_at=_now_utc(),
        )
        db.session.add(chat_device)
        db.session.flush()
        _store_one_time_prekeys(chat_device, prekeys)

        client = SpacetimeHttpClient()
        try:
            _ensure_device_transport_identity(chat_device, current_user, client)
            _emit_device_roster_change(
                client,
                current_user.id,
                chat_device.device_id,
                'device_added',
                current_user.id,
                chat_device.device_id,
            )
            db.session.commit()
        except SpacetimeApiError as err:
            db.session.rollback()
            abort(502, message=f"Failed to provision chat device transport identity: {str(err)}")

        session[_chat_device_session_key()] = chat_device.device_id
        return {
            'device': _serialize_device_summary(chat_device),
            'remaining_one_time_prekeys': _count_available_one_time_prekeys(chat_device),
            'transport_ready': bool(chat_device.transport_identity_mapping),
            'message': 'Chat device registered successfully.',
        }, 201


class ChatE2EEDeviceLinkSessionResource(Resource):
    @login_required
    def post(self):
        if not _chat_e2ee_enabled():
            abort(403, message="End-to-end encrypted chat is disabled.")

        if not _active_chat_devices_for_user(current_user.id):
            abort(409, message="No active chat device exists yet. Register the first device before linking another.")

        data = request.get_json(silent=True) or {}
        device_payload = _parse_device_payload(data)
        if _device_by_user_and_id(current_user.id, device_payload['device_id']):
            abort(409, message="A chat device with this `device_id` already exists for the current user.")

        approval_code = _generate_approval_code()
        expires_at = _now_utc() + timedelta(minutes=int(current_app.config.get('CHAT_DEVICE_LINK_TTL_MINUTES', 10)))

        for stale_session in ChatDeviceLinkSession.query.filter_by(
            user_id=current_user.id,
            pending_device_id=device_payload['device_id'],
            status=ChatDeviceLinkSessionStatus.PENDING,
        ).all():
            stale_session.status = ChatDeviceLinkSessionStatus.EXPIRED

        link_session = ChatDeviceLinkSession(
            user_id=current_user.id,
            pending_device_id=device_payload['device_id'],
            pending_identity_key_public=device_payload['identity_key_public'],
            pending_signing_key_public=device_payload['signing_key_public'],
            pending_signed_prekey_id=device_payload['signed_prekey_id'],
            pending_signed_prekey_public=device_payload['signed_prekey_public'],
            pending_signed_prekey_signature=device_payload['signed_prekey_signature'],
            status=ChatDeviceLinkSessionStatus.PENDING,
            approval_code_hash=generate_password_hash(approval_code),
            expires_at=expires_at,
        )
        db.session.add(link_session)
        db.session.commit()

        return {
            'link_session_id': link_session.id,
            'expires_at': _serialize_datetime(link_session.expires_at),
            'approval_code': approval_code,
        }, 201


class ChatE2EEDeviceLinkApproveResource(Resource):
    @login_required
    def post(self, link_session_id):
        approver_device = _require_current_chat_device()
        data = request.get_json(silent=True) or {}
        approval_code = _require_non_empty_string(data, 'approval_code')
        prekeys = _parse_one_time_prekeys(data) if data.get('one_time_prekeys') is not None else []

        approver_device_id = data.get('approver_device_id')
        if approver_device_id is not None and approver_device_id != approver_device.device_id:
            abort(403, message="`approver_device_id` does not match the active chat device for this session.")

        link_session = db.session.get(ChatDeviceLinkSession, link_session_id)
        if not link_session or link_session.user_id != current_user.id:
            abort(404, message="Link session was not found.")

        _ensure_pending_link_session(link_session)
        if not check_password_hash(link_session.approval_code_hash, approval_code):
            abort(403, message="Approval code is invalid.")
        if _device_by_user_and_id(current_user.id, link_session.pending_device_id):
            abort(409, message="The pending device has already been registered.")

        chat_device = ChatDevice(
            user_id=current_user.id,
            device_id=link_session.pending_device_id,
            device_kind=ChatDeviceKind.LINKED,
            status=ChatDeviceStatus.ACTIVE,
            identity_key_public=link_session.pending_identity_key_public,
            signing_key_public=link_session.pending_signing_key_public,
            signed_prekey_id=link_session.pending_signed_prekey_id,
            signed_prekey_public=link_session.pending_signed_prekey_public,
            signed_prekey_signature=link_session.pending_signed_prekey_signature,
            approved_by_device_id=approver_device.device_id,
            linked_at=_now_utc(),
            last_seen_at=_now_utc(),
        )
        db.session.add(chat_device)
        db.session.flush()
        if prekeys:
            _store_one_time_prekeys(chat_device, prekeys)

        client = SpacetimeHttpClient()
        try:
            _ensure_device_transport_identity(chat_device, current_user, client)
            _emit_device_roster_change(
                client,
                current_user.id,
                chat_device.device_id,
                'device_added',
                current_user.id,
                approver_device.device_id,
            )
        except SpacetimeApiError as err:
            db.session.rollback()
            abort(502, message=f"Failed to provision chat device transport identity: {str(err)}")

        link_session.status = ChatDeviceLinkSessionStatus.APPROVED
        link_session.approved_by_device_id = approver_device.device_id
        db.session.commit()

        return {
            'device': _serialize_device_summary(chat_device),
            'remaining_one_time_prekeys': _count_available_one_time_prekeys(chat_device),
            'transport_ready': bool(chat_device.transport_identity_mapping),
            'message': 'Chat device link approved successfully.',
        }, 200


class ChatE2EEDeviceLinkCompleteResource(Resource):
    @login_required
    def post(self, link_session_id):
        link_session = db.session.get(ChatDeviceLinkSession, link_session_id)
        if not link_session or link_session.user_id != current_user.id:
            abort(404, message="Link session was not found.")

        if link_session.status == ChatDeviceLinkSessionStatus.PENDING and link_session.expires_at <= _now_utc():
            link_session.status = ChatDeviceLinkSessionStatus.EXPIRED
            db.session.commit()

        if link_session.status == ChatDeviceLinkSessionStatus.EXPIRED:
            return {
                'status': ChatDeviceLinkSessionStatus.EXPIRED.value,
                'current_device_id': None,
                'transport_ready': False,
            }, 200

        if link_session.status != ChatDeviceLinkSessionStatus.APPROVED:
            return {
                'status': link_session.status.value,
                'current_device_id': None,
                'transport_ready': False,
            }, 200

        chat_device = _device_by_user_and_id(current_user.id, link_session.pending_device_id)
        if not chat_device or chat_device.status != ChatDeviceStatus.ACTIVE:
            abort(409, message="Approved chat device could not be activated.")

        session[_chat_device_session_key()] = chat_device.device_id
        link_session.status = ChatDeviceLinkSessionStatus.CONSUMED
        chat_device.last_seen_at = _now_utc()
        db.session.commit()

        return {
            'status': 'active',
            'current_device_id': chat_device.device_id,
            'transport_ready': bool(chat_device.transport_identity_mapping),
        }, 200


class ChatE2EEDeviceSignedPrekeyResource(Resource):
    @login_required
    def post(self, device_id):
        chat_device = _device_by_user_and_id(current_user.id, _sanitize_device_id(device_id))
        if not chat_device:
            abort(404, message="Chat device was not found.")
        if chat_device.status != ChatDeviceStatus.ACTIVE:
            abort(409, message="Signed prekeys can only be rotated for active chat devices.")

        data = request.get_json(silent=True) or {}
        chat_device.signed_prekey_id = _require_integer(data, 'signed_prekey_id')
        chat_device.signed_prekey_public = _require_non_empty_string(data, 'signed_prekey_public')
        chat_device.signed_prekey_signature = _require_non_empty_string(data, 'signed_prekey_signature')
        chat_device.updated_at = _now_utc()
        db.session.commit()

        return {
            'device_id': chat_device.device_id,
            'signed_prekey_id': chat_device.signed_prekey_id,
            'message': 'Signed prekey rotated successfully.',
        }, 200


class ChatE2EEDeviceOneTimePrekeysResource(Resource):
    @login_required
    def post(self, device_id):
        chat_device = _device_by_user_and_id(current_user.id, _sanitize_device_id(device_id))
        if not chat_device:
            abort(404, message="Chat device was not found.")
        if chat_device.status != ChatDeviceStatus.ACTIVE:
            abort(409, message="One-time prekeys can only be replenished for active chat devices.")

        data = request.get_json(silent=True) or {}
        inserted = _store_one_time_prekeys(chat_device, _parse_one_time_prekeys(data))
        chat_device.updated_at = _now_utc()
        db.session.commit()

        return {
            'device_id': chat_device.device_id,
            'inserted_count': inserted,
            'remaining_one_time_prekeys': _count_available_one_time_prekeys(chat_device),
            'message': 'One-time prekeys stored successfully.',
        }, 200


class ChatE2EEUserDeviceBundleResource(Resource):
    @login_required
    def get(self, user_id):
        target_user = db.session.get(User, user_id)
        if not target_user:
            abort(404, message="User was not found.")
        if target_user.id != current_user.id and not current_user.is_friend(target_user):
            abort(403, message="Device bundles can only be fetched for yourself or accepted friends.")

        claim_prekeys = _parse_query_bool('claim_prekeys', default=(target_user.id != current_user.id))
        devices = _active_chat_devices_for_user(target_user.id)
        payload = {
            'user_id': target_user.id,
            'devices': [_serialize_device_bundle(device, claim_prekey=claim_prekeys) for device in devices],
        }
        db.session.commit()
        return payload, 200


class ChatE2EEConversationDeviceBundleResource(Resource):
    @login_required
    def get(self, conversation_id):
        if not _conversation_id_safe(conversation_id):
            abort(400, message="Invalid conversation ID.")

        client = SpacetimeHttpClient()
        try:
            conversation_row = _get_conversation_row(client, conversation_id)
            if not conversation_row:
                abort(404, message="Conversation was not found.")
            member_ids = _get_conversation_member_ids(client, conversation_id)
        except SpacetimeApiError as err:
            abort(502, message=f"Failed to load conversation device bundles: {str(err)}")

        if int(current_user.id) not in member_ids:
            abort(403, message="You are not a member of this conversation.")

        members_payload = []
        should_claim_prekeys = _parse_query_bool('claim_prekeys', default=True)
        for member_id in member_ids:
            member_user = db.session.get(User, member_id)
            if not member_user:
                continue
            claim_prekeys = should_claim_prekeys and member_user.id != current_user.id
            devices = _active_chat_devices_for_user(member_user.id)
            members_payload.append({
                'user_id': member_user.id,
                'devices': [_serialize_device_bundle(device, claim_prekey=claim_prekeys) for device in devices],
            })
        db.session.commit()

        return {
            'conversation_id': conversation_id,
            'members': members_payload,
        }, 200


class ChatE2EEDeviceRevokeResource(Resource):
    @login_required
    def post(self, device_id):
        acting_device = _require_current_chat_device()
        target_device = _device_by_user_and_id(current_user.id, _sanitize_device_id(device_id))
        if not target_device:
            abort(404, message="Chat device was not found.")
        if acting_device.status != ChatDeviceStatus.ACTIVE:
            abort(409, message="Only an active chat device can revoke another device.")
        if target_device.status == ChatDeviceStatus.REVOKED:
            return {
                'device_id': target_device.device_id,
                'message': 'Chat device is already revoked.',
            }, 200

        target_device.status = ChatDeviceStatus.REVOKED
        target_device.revoked_at = _now_utc()
        target_device.updated_at = _now_utc()
        target_device.last_seen_at = _now_utc()
        for prekey in target_device.one_time_prekeys:
            if prekey.claimed_at is None:
                prekey.claimed_at = _now_utc()
        if target_device.transport_identity_mapping:
            db.session.delete(target_device.transport_identity_mapping)
        if session.get(_chat_device_session_key()) == target_device.device_id:
            session.pop(_chat_device_session_key(), None)
        client = SpacetimeHttpClient()
        try:
            _emit_device_roster_change(
                client,
                current_user.id,
                target_device.device_id,
                'device_revoked',
                current_user.id,
                acting_device.device_id,
            )
            db.session.commit()
        except SpacetimeApiError as err:
            db.session.rollback()
            abort(502, message=f"Failed to emit device revocation event: {str(err)}")

        return {
            'device_id': target_device.device_id,
            'message': 'Chat device revoked successfully.',
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
        encryption_mode = _parse_encryption_mode(data)

        if not isinstance(target_user_id, int):
            abort(400, message="`user_id` must be an integer.")

        target_user = db.session.get(User, target_user_id)
        if not target_user:
            abort(404, message="Target user was not found.")
        if target_user.id == current_user.id:
            abort(400, message="You cannot create a direct chat with yourself.")
        if not current_user.is_friend(target_user):
            abort(403, message="Direct chats can only be created between accepted friends.")
        if encryption_mode == E2EE_ENCRYPTION_MODE:
            _assert_encrypted_conversation_creation_allowed([current_user.id, target_user.id])

        client = SpacetimeHttpClient()
        low_id, high_id = sorted((int(current_user.id), int(target_user.id)))
        conversation_id = f"dm:{low_id}:{high_id}"
        title = f"DM: {current_user.username} & {target_user.username}"

        try:
            client.call_reducer(
                'ensure_dm',
                [
                    conversation_id,
                    low_id,
                    high_id,
                    title,
                    encryption_mode,
                ]
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
        encryption_mode = _parse_encryption_mode(data)

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
        if encryption_mode == E2EE_ENCRYPTION_MODE:
            _assert_encrypted_conversation_creation_allowed(participant_ids)

        client = SpacetimeHttpClient()
        conversation_id = f"grp:{uuid.uuid4().hex}"

        try:
            client.call_reducer(
                'create_group',
                [
                    conversation_id,
                    title.strip(),
                    int(current_user.id),
                    participant_ids,
                    encryption_mode,
                ]
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
        current_chat_device = _current_chat_device(auto_select=True)
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
            if conversation_row.get('encryption_mode') == E2EE_ENCRYPTION_MODE:
                _assert_encrypted_group_member_ready(user_id)
            client.call_reducer(
                'add_group_member',
                [
                    conversation_id,
                    int(user_id),
                    int(current_user.id),
                    current_chat_device.device_id if current_chat_device else None,
                ]
            )
        except SpacetimeApiError as err:
            abort(502, message=f"Failed to add group member: {str(err)}")

        return {
            'conversation_id': conversation_id,
            'user_id': user_id,
            'message': 'Group member added successfully.',
        }, 201
