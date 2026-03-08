import pytest
from app import create_app
from extensions import db as _ext_db # Import db from extensions
from models import User, Post, Comment, Ampersound
from models import UserType, PostPrivacy, CommentVisibility
from werkzeug.security import generate_password_hash
from flask_login import login_user, logout_user
import os
import tempfile
import shutil
import uuid # Import uuid

@pytest.fixture(scope='session')
def app():
    """Create and configure a new app instance for each test session."""
    db_fd, db_path = tempfile.mkstemp()
    temp_upload_folder = tempfile.mkdtemp()

    test_config_overrides = {
        'SQLALCHEMY_DATABASE_URI': f'sqlite:///{db_path}',
        'UPLOAD_FOLDER': temp_upload_folder,
        'JWT_SECRET_KEY': 'test_secret_key',
        'INVITE_ONLY': False,
        'MAIL_SERVER': 'localhost', # Test-friendly mail setup
        'MAIL_PORT': 1025,
        'MAIL_USE_TLS': False,
        'MAIL_USERNAME': None,
        'MAIL_PASSWORD': None,
        'MAIL_DEFAULT_SENDER': 'noreply@example.com',
        'DEEPINFRA_API_KEY': None, # Ensure external services are off
        'SPACETIMEDB_HTTP_URL': 'https://maincloud.spacetimedb.com',
        'SPACETIMEDB_WS_URL': 'wss://maincloud.spacetimedb.com',
        'SPACETIMEDB_DB_NAME': 'socialnetworkdotsocial-48xhr',
        'SPACETIMEDB_DB_ID': 'c20069a056fa0538d26edbfe04785fe43b106f2fd5721f4a6555cf67f4090f93',
        'SPACETIMEDB_SERVICE_TOKEN': 'test-service-token',
        'SPACETIMEDB_TOKEN_ENCRYPTION_KEY': 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
        # TestingConfig in app.py should handle:
        # 'TESTING': True,
        # 'WTF_CSRF_ENABLED': False,
        # 'S3_BUCKET': None,
        # 'OPENAI_API_KEY': None,
    }

    # Create the app with the 'testing' configuration name from app.py
    # and pass overrides directly
    _app = create_app(config_name='testing', overrides=test_config_overrides)

    with _app.app_context():
        # _ext_db.init_app(_app) # Already done in create_app
        _ext_db.create_all()

    yield _app

    # Clean up temporary resources
    with _app.app_context():
        _ext_db.drop_all()
        
    os.close(db_fd)
    os.unlink(db_path)
    if os.path.exists(temp_upload_folder):
        shutil.rmtree(temp_upload_folder)

@pytest.fixture(scope='function')
def client(app):
    """A test client for the app."""
    return app.test_client()

@pytest.fixture(scope='function')
def db(app):
    """Function-scoped test database. Creates and drops tables for each test."""
    current_db_instance = app.extensions['sqlalchemy']
    
    yield current_db_instance

@pytest.fixture(scope='function')
def db_session(db): # 'db' here is current_db_instance from the above fixture
    """Creates a new database session for a test, ensuring transaction isolation."""
    connection = db.engine.connect()  # Use the engine from the yielded db instance
    transaction = connection.begin()
    
    # Create a new scoped session bound to this transaction's connection
    options = dict(bind=connection, binds={})
    test_specific_session = db._make_scoped_session(options=options)
    
    # Monkeypatch the session on the Flask-SQLAlchemy instance for this test's duration
    original_session = db.session
    db.session = test_specific_session

    yield test_specific_session # The test can use this session

    # Teardown
    db.session = original_session # Restore original session on the Flask-SQLAlchemy instance
    test_specific_session.remove()
    transaction.rollback()
    connection.close()

# --- Model Creation Fixture Factories (as functions for reusability) ---

@pytest.fixture
def create_user(db_session):
    user_counter = 0
    def _create_user(username="testuser", email="test@example.com", password="password123", user_type=UserType.USER, commit=True):
        nonlocal user_counter
        user_counter += 1
        unique_suffix = str(uuid.uuid4()).split('-')[0] # Short unique id
        
        final_username = username
        final_email = email

        # Default emails that need to be made unique across tests in the same session
        default_emails_to_uniquify = [
            "test@example.com", 
            "regular@example.com", 
            "admin@example.com",
            "postauthor@example.com",
            "commenter@example.com", # Covers 'commenterUser' with 'commenter@example.com'
            "commentpostauthor@example.com",
            "ampsoundowner@example.com"
        ]

        if email in default_emails_to_uniquify:
            final_email = f"{email.split('@')[0]}_{unique_suffix}@{email.split('@')[1]}"
            # If username is also its corresponding default, make it unique too
            if (email == "test@example.com" and username == "testuser") or \
               (email == "regular@example.com" and username == "testregular") or \
               (email == "admin@example.com" and username == "testadmin") or \
               (email == "postauthor@example.com" and username == "postauthor") or \
               (email == "commenter@example.com" and username == "commenter") or \
               (email == "commentpostauthor@example.com" and username == "commentpostauthor") or \
               (email == "ampsoundowner@example.com" and username == "ampsoundowner"):
                final_username = f"{username}_{unique_suffix}"
            # If email is a default but username is custom (e.g. 'commenterUser' with 'commenter@example.com'),
            # final_username is already set to the custom username, which is fine.

        user = User(
            username=final_username, 
            email=final_email, 
            password_hash=generate_password_hash(password, method='pbkdf2:sha256'),
            user_type=user_type
        )
        db_session.add(user)
        if commit:
            try:
                db_session.commit()
            except Exception as e:
                db_session.rollback()
                raise e
        return user
    return _create_user

@pytest.fixture
def create_post(db_session, create_user):
    def _create_post(user_id=None, content="Test Post Content", privacy=PostPrivacy.PUBLIC, commit=True):
        if user_id is None:
            # Create a default user if none provided
            default_user = create_user(username='postauthor', email='postauthor@example.com', commit=False) # Don't commit yet if part of larger transaction
            db_session.add(default_user)
            db_session.flush() # Get ID for default_user
            user_id = default_user.id

        post = Post(user_id=user_id, content=content, privacy=privacy)
        db_session.add(post)
        if commit:
            try:
                db_session.commit()
            except Exception as e:
                db_session.rollback()
                raise e
        return post
    return _create_post

@pytest.fixture
def create_comment(db_session, create_user, create_post):
    def _create_comment(user_id=None, post_id=None, content="Test Comment Content", visibility=CommentVisibility.PUBLIC, commit=True):
        if user_id is None:
            default_user = create_user(username='commenter', email='commenter@example.com', commit=False)
            db_session.add(default_user)
            db_session.flush()
            user_id = default_user.id
        
        if post_id is None:
            # Create a default post if none provided
            default_post_author = create_user(username='commentpostauthor', email='commentpostauthor@example.com', commit=False)
            db_session.add(default_post_author)
            db_session.flush()
            default_post = create_post(user_id=default_post_author.id, content="Parent post for comment", commit=False)
            db_session.add(default_post)
            db_session.flush()
            post_id = default_post.id

        comment = Comment(user_id=user_id, post_id=post_id, content=content, visibility=visibility)
        db_session.add(comment)
        if commit:
            try:
                db_session.commit()
            except Exception as e:
                db_session.rollback()
                raise e
        return comment
    return _create_comment

@pytest.fixture
def create_ampersound(db_session, create_user):
    def _create_ampersound(user_id=None, name="testsound", file_path="path/to/test.mp3", privacy="public", commit=True):
        if user_id is None:
            default_user = create_user(username='ampsoundowner', email='ampsoundowner@example.com', commit=False)
            db_session.add(default_user)
            db_session.flush()
            user_id = default_user.id
        
        ampersound = Ampersound(user_id=user_id, name=name, file_path=file_path, privacy=privacy)
        db_session.add(ampersound)
        if commit:
            try:
                db_session.commit()
            except Exception as e:
                db_session.rollback()
                raise e
        return ampersound
    return _create_ampersound

# --- Auth Fixtures ---

@pytest.fixture
def regular_user_auth_data(client, create_user, db_session, app):
    unique_suffix = str(uuid.uuid4()).split('-')[0]
    email = f"regular_{unique_suffix}@example.com"
    username = f"testregular_{unique_suffix}"

    user = create_user(username=username, email=email, password='password')
    # db_session.commit() # create_user handles commit

    login_resp = client.post('/api/v1/login', json={
        'identifier': user.email,
        'password': 'password'
    })
    assert login_resp.status_code == 200, f"Login failed for {user.email}: {login_resp.get_json()}"
    yield {'headers': {}, 'user': user} # headers is currently unused effectively
    
    with app.test_request_context('/'): 
        logout_user()

@pytest.fixture
def admin_user_auth_data(client, create_user, db_session, app):
    unique_suffix = str(uuid.uuid4()).split('-')[0]
    email = f"admin_{unique_suffix}@example.com"
    username = f"testadmin_{unique_suffix}"

    admin_user = create_user(username=username, email=email, password='password', user_type=UserType.ADMIN)
    # db_session.commit() # create_user handles commit

    login_resp = client.post('/api/v1/login', json={
        'identifier': admin_user.email,
        'password': 'password'
    })
    assert login_resp.status_code == 200, f"Login failed for {admin_user.email}: {login_resp.get_json()}"
    yield {'headers': {}, 'user': admin_user} # headers is currently unused effectively
    
    with app.test_request_context('/'):
        logout_user()

# Note: The auth fixtures above assume a POST to /api/v1/login for session setup.
# If your login mechanism is different (e.g., token-based, or login_user directly sets a cookie 
# the client picks up without a POST), these might need adjustment.
# The key is that subsequent requests from `client` in the test are authenticated as the
