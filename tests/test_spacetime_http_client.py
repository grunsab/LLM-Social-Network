import requests

import resources.chat as chat_module


class _FakeResponse:
    def __init__(self, status_code=200, payload=None, text=None):
        self.status_code = status_code
        self._payload = payload
        if text is not None:
            self.text = text
        elif payload is None:
            self.text = ''
        else:
            self.text = 'json'

    def json(self):
        if self._payload is None:
            raise ValueError('No JSON payload')
        return self._payload


def test_spacetime_call_reducer_posts_argument_array(app, monkeypatch):
    captured = {}

    def _fake_post(url, json=None, data=None, headers=None, timeout=None):
        captured['url'] = url
        captured['json'] = json
        captured['data'] = data
        captured['headers'] = headers
        captured['timeout'] = timeout
        return _FakeResponse(payload={'ok': True})

    monkeypatch.setattr(chat_module.requests, 'post', _fake_post)

    with app.app_context():
        original_db_name = app.config['SPACETIMEDB_DB_NAME']
        original_db_id = app.config['SPACETIMEDB_DB_ID']
        app.config['SPACETIMEDB_DB_NAME'] = None
        app.config['SPACETIMEDB_DB_ID'] = 'c20069a056fa0538d26edbfe04785fe43b106f2fd5721f4a6555cf67f4090f93'
        try:
            client = chat_module.SpacetimeHttpClient()
            payload = {
                'user_id': 1,
                'identity': '0x0000000000000000000000000000000000000000000000000000000000000001',
            }
            response = client.call_reducer('register_user_identity', payload)
        finally:
            app.config['SPACETIMEDB_DB_NAME'] = original_db_name
            app.config['SPACETIMEDB_DB_ID'] = original_db_id

    assert response == {'ok': True}
    assert captured['url'].endswith('/v1/database/c20069a056fa0538d26edbfe04785fe43b106f2fd5721f4a6555cf67f4090f93/call/register_user_identity')
    assert captured['json'] == [payload]
    assert captured['data'] is None
    assert captured['headers']['Authorization'] == 'Bearer test-service-token'


def test_spacetime_run_sql_posts_plain_text_and_normalizes_rows(app, monkeypatch):
    captured = {}

    def _fake_post(url, json=None, data=None, headers=None, timeout=None):
        captured['url'] = url
        captured['json'] = json
        captured['data'] = data
        captured['headers'] = headers
        captured['timeout'] = timeout
        return _FakeResponse(payload=[
            {
                'schema': {
                    'elements': [
                        {'name': {'some': 'conversation_id'}},
                        {'name': {'some': 'kind'}},
                        {'name': {'some': 'title'}},
                    ]
                },
                'rows': [
                    ['grp:test-room', 'group', 'Test Room'],
                ],
            }
        ])

    monkeypatch.setattr(chat_module.requests, 'post', _fake_post)

    with app.app_context():
        client = chat_module.SpacetimeHttpClient()
        rows = client.run_sql('SELECT conversation_id, kind, title FROM conversation')

    assert captured['url'].endswith('/v1/database/socialnetworkdotsocial-48xhr/sql')
    assert captured['json'] is None
    assert captured['data'] == 'SELECT conversation_id, kind, title FROM conversation'
    assert captured['headers']['Content-Type'].startswith('text/plain')
    assert rows == [
        {
            'conversation_id': 'grp:test-room',
            'kind': 'group',
            'title': 'Test Room',
        }
    ]


def test_spacetime_post_wraps_request_errors(app, monkeypatch):
    def _fake_post(url, json=None, data=None, headers=None, timeout=None):
        raise requests.RequestException('network down')

    monkeypatch.setattr(chat_module.requests, 'post', _fake_post)

    with app.app_context():
        client = chat_module.SpacetimeHttpClient()
        try:
            client.create_identity()
            assert False, 'Expected SpacetimeApiError'
        except chat_module.SpacetimeApiError as err:
            assert 'Failed to reach SpaceTimeDB' in str(err)
