import pytest
import json
from werkzeug.security import check_password_hash

from models import User # Import User model to check DB later if needed

# Remove the old test_home_page
# def test_home_page(test_client):
#     """Test the home page loads correctly."""
#     response = test_client.get('/')
#     assert response.status_code == 200
#     assert b'Welcome' in response.data # Adjust this assertion based on your actual homepage content

def test_user_registration_success(client):
    """Test successful user registration."""
    response = client.post('/api/v1/register', json={
        'username': 'testuser',
        'email': 'test@example.com',
        'password': 'password123'
    })
    assert response.status_code == 201
    data = response.get_json()
    assert data['message'] == "User created successfully"
    assert 'user_id' in data
    # Optionally, check database directly (requires db access in test)
    # user = User.query.filter_by(username='testuser').first()
    # assert user is not None
    # assert check_password_hash(user.password_hash, 'password123')

def test_user_registration_missing_data(client):
    """Test user registration with missing data."""
    response = client.post('/api/v1/register', json={
        'username': 'testuser2'
        # Missing email and password
    })
    assert response.status_code == 400 # Bad Request
    data = response.get_json()
    assert 'message' in data
    # The exact message might depend on Flask-RESTful reqparse implementation
    assert 'email' in data['message'] 
    assert 'password' in data['message']

def test_user_registration_duplicate_username(client):
    """Test registration with a username that already exists."""
    # First, register a user
    reg_response = client.post('/api/v1/register', json={
        'username': 'duplicateuser',
        'email': 'dup1@example.com',
        'password': 'password123'
    })
    assert reg_response.status_code == 201 # Ensure prerequisite registration worked
    
    # Try registering again with the same username
    response = client.post('/api/v1/register', json={
        'username': 'duplicateuser',
        'email': 'dup2@example.com',
        'password': 'password456'
    })
    assert response.status_code == 409
    data = response.get_json()
    assert 'message' in data
    assert 'Username already exists' in data['message']

def test_user_registration_duplicate_email(client):
    """Test registration with an email that already exists."""
    # First, register a user
    reg_response = client.post('/api/v1/register', json={
        'username': 'emailuser1',
        'email': 'duplicate@example.com',
        'password': 'password123'
    })
    assert reg_response.status_code == 201 # Ensure prerequisite registration worked

    # Try registering again with the same email
    response = client.post('/api/v1/register', json={
        'username': 'emailuser2',
        'email': 'duplicate@example.com',
        'password': 'password456'
    })
    assert response.status_code == 409
    data = response.get_json()
    assert 'message' in data
    assert 'Email already exists' in data['message'] 

# --- Login Tests ---

def test_user_login_success(client):
    """Test successful login with username and password."""
    # Register user first
    reg_response = client.post('/api/v1/register', json={
        'username': 'loginuser',
        'email': 'login@example.com',
        'password': 'password123'
    })
    assert reg_response.status_code == 201

    # Attempt login
    login_response = client.post('/api/v1/login', json={
        'identifier': 'loginuser', # Using username
        'password': 'password123'
    })
    assert login_response.status_code == 200
    data = login_response.get_json()
    assert data['message'] == 'Login successful'
    assert 'user' in data
    assert data['user']['username'] == 'loginuser'
    assert data['user']['email'] == 'login@example.com'

def test_user_login_success_with_email(client):
    """Test successful login with email and password."""
    # Register user first (use different user to avoid conflicts)
    reg_response = client.post('/api/v1/register', json={
        'username': 'loginuser_email',
        'email': 'login_email@example.com',
        'password': 'password123'
    })
    assert reg_response.status_code == 201

    # Attempt login using email
    login_response = client.post('/api/v1/login', json={
        'identifier': 'login_email@example.com', # Using email
        'password': 'password123'
    })
    assert login_response.status_code == 200
    data = login_response.get_json()
    assert data['message'] == 'Login successful'
    assert data['user']['username'] == 'loginuser_email'

def test_user_login_wrong_password(client):
    """Test login with incorrect password."""
    # Register user first
    reg_response = client.post('/api/v1/register', json={
        'username': 'wrongpassuser',
        'email': 'wrongpass@example.com',
        'password': 'password123'
    })
    assert reg_response.status_code == 201

    # Attempt login with wrong password
    login_response = client.post('/api/v1/login', json={
        'identifier': 'wrongpassuser',
        'password': 'wrongpassword'
    })
    assert login_response.status_code == 401 # Unauthorized
    data = login_response.get_json()
    assert data['message'] == 'Invalid credentials'

def test_user_login_nonexistent_user(client):
    """Test login with a username that does not exist."""
    login_response = client.post('/api/v1/login', json={
        'identifier': 'nosuchuser',
        'password': 'password123'
    })
    assert login_response.status_code == 401 # Unauthorized
    data = login_response.get_json()
    assert data['message'] == 'Invalid credentials'

def test_user_login_missing_data(client):
    """Test login with missing identifier or password."""
    # Missing password
    response_no_pass = client.post('/api/v1/login', json={
        'identifier': 'testuser'
    })
    assert response_no_pass.status_code == 400
    assert 'Missing username/email or password' in response_no_pass.get_json()['message']

    # Missing identifier
    response_no_id = client.post('/api/v1/login', json={
        'password': 'password123'
    })
    assert response_no_id.status_code == 400
    assert 'Missing username/email or password' in response_no_id.get_json()['message']

# --- Logout Test ---

def test_user_logout_success(client):
    """Test successful logout."""
    # Register and Login first
    client.post('/api/v1/register', json={
        'username': 'logoutuser',
        'email': 'logout@example.com',
        'password': 'password123'
    })
    login_response = client.post('/api/v1/login', json={
        'identifier': 'logoutuser',
        'password': 'password123'
    })
    assert login_response.status_code == 200 # Ensure login was successful

    # Attempt logout using POST request to /api/v1/logout
    logout_response = client.post('/api/v1/logout')
    assert logout_response.status_code == 200
    assert logout_response.get_json()['message'] == 'Successfully logged out' # Check message

    # Verify logout by trying to access a login-required endpoint (e.g., logout again)
    verify_logout_response = client.post('/api/v1/logout') # Try POST to /api/v1/logout again
    # Expect 401 Unauthorized as per login_manager.unauthorized_handler
    assert verify_logout_response.status_code == 401

def test_user_logout_not_logged_in(client):
    """Test attempting logout when not logged in."""
    logout_response = client.post('/api/v1/logout')
    # Since @login_required is used, and unauthorized_handler returns 401
    assert logout_response.status_code == 401

# --- Post Tests ---

def test_create_post_unauthorized(client):
    """Test creating a post fails if not logged in."""
    response = client.post('/api/v1/posts', json={
        'content': 'This post should not be created'
    })
    # Expect 401 Unauthorized
    assert response.status_code == 401

def test_create_post_defaults_to_friends_privacy(client):
    """New posts should default to FRIENDS when privacy is omitted."""
    client.post('/api/v1/register', json={
        'username': 'privacydefaultuser',
        'email': 'privacydefault@example.com',
        'password': 'password123'
    })
    login_response = client.post('/api/v1/login', json={
        'identifier': 'privacydefaultuser',
        'password': 'password123'
    })
    assert login_response.status_code == 200

    create_response = client.post('/api/v1/posts', data={
        'content': 'This post should be friends-only by default'
    })
    assert create_response.status_code == 201
    create_data = create_response.get_json()
    assert create_data['post']['privacy'] == 'FRIENDS'


def test_create_and_list_posts_success(client):
    """Test successfully creating a post and listing it."""
    # 1. Register and Login
    client.post('/api/v1/register', json={
        'username': 'postuser',
        'email': 'postuser@example.com',
        'password': 'password123'
    })
    login_response = client.post('/api/v1/login', json={
        'identifier': 'postuser',
        'password': 'password123'
    })
    assert login_response.status_code == 200

    # 2. List posts (should be empty initially for this user)
    list_response_before = client.get('/api/v1/posts')
    assert list_response_before.status_code == 200
    data_before = list_response_before.get_json()
    # Check structure for pagination/posts list
    assert 'posts' in data_before
    assert 'page' in data_before
    assert 'total' in data_before
    initial_post_count = len(data_before['posts']) 
    # We check relative counts later as other tests might create posts

    # 3. Create a post
    post_content = "This is the first post by postuser!"
    create_response = client.post('/api/v1/posts', data={
        'content': post_content,
        'privacy': 'PUBLIC'
    })
    if create_response.status_code == 400:
        print("Create Post Failed (400):", create_response.get_json())
    assert create_response.status_code == 201

    create_data = create_response.get_json()
    assert 'post' in create_data
    assert 'id' in create_data['post']
    assert create_data['post']['content'] == post_content
    assert create_data['post']['author']['username'] == 'postuser'
    created_post_id = create_data['post']['id']

    # 4. List posts again (should contain the new post)
    list_response_after = client.get('/api/v1/posts')
    assert list_response_after.status_code == 200
    data_after = list_response_after.get_json()
    assert len(data_after['posts']) == initial_post_count + 1
    
    # Find the created post in the list
    found_post = None
    for post in data_after['posts']:
        if post['id'] == created_post_id:
            found_post = post
            break
    
    assert found_post is not None
    assert found_post['content'] == post_content
    assert found_post['author']['username'] == 'postuser'

def test_get_specific_post_success(client):
    """Test fetching a specific post successfully."""
    # 1. Register, Login, Create Post
    client.post('/api/v1/register', json={'username': 'getpostuser', 'email': 'getpost@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'getpostuser', 'password': 'p'})
    post_content = "Specific post content"
    create_response = client.post('/api/v1/posts', data={'content': post_content, 'privacy': 'PUBLIC'})
    assert create_response.status_code == 201
    created_post_id = create_response.get_json()['post']['id']

    # 2. Fetch the specific post
    get_response = client.get(f'/api/v1/posts/{created_post_id}')
    assert get_response.status_code == 200
    get_data = get_response.get_json()
    assert get_data['id'] == created_post_id
    assert get_data['content'] == post_content
    assert get_data['author']['username'] == 'getpostuser'

def test_get_specific_post_not_found(client):
    """Test fetching a non-existent post."""
    # Need to be logged in to fetch posts generally according to PostResource logic
    client.post('/api/v1/register', json={'username': 'getpostuser_nf', 'email': 'getpost_nf@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'getpostuser_nf', 'password': 'p'})

    get_response = client.get('/api/v1/posts/99999') # Assume 99999 doesn't exist
    assert get_response.status_code == 404

def test_delete_post_success(client):
    """Test deleting a post successfully by its author."""
    # 1. Register, Login, Create Post
    client.post('/api/v1/register', json={'username': 'deletepostuser', 'email': 'deletepost@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'deletepostuser', 'password': 'p'})
    create_response = client.post('/api/v1/posts', data={'content': 'To be deleted', 'privacy': 'PUBLIC'})
    assert create_response.status_code == 201
    created_post_id = create_response.get_json()['post']['id']

    # 2. Delete the post
    delete_response = client.delete(f'/api/v1/posts/{created_post_id}')
    assert delete_response.status_code == 200 # Or 204 No Content is also common
    assert delete_response.get_json()['message'] == 'Post deleted successfully.'

    # 3. Verify post is deleted (GET should return 404)
    get_response = client.get(f'/api/v1/posts/{created_post_id}')
    assert get_response.status_code == 404

def test_delete_post_unauthorized(client):
    """Test attempting to delete a post by a non-author."""
    # 1. Register User A and User B
    client.post('/api/v1/register', json={'username': 'authoruser', 'email': 'author@example.com', 'password': 'p'})
    client.post('/api/v1/register', json={'username': 'otheruser', 'email': 'other@example.com', 'password': 'p'})

    # 2. User A logs in and creates a post
    client.post('/api/v1/login', json={'identifier': 'authoruser', 'password': 'p'})
    create_response = client.post('/api/v1/posts', data={'content': 'Authors post', 'privacy': 'PUBLIC'})
    assert create_response.status_code == 201
    created_post_id = create_response.get_json()['post']['id']
    client.delete('/api/v1/login') # Log out User A

    # 3. User B logs in and tries to delete User A's post
    client.post('/api/v1/login', json={'identifier': 'otheruser', 'password': 'p'})
    delete_response = client.delete(f'/api/v1/posts/{created_post_id}')
    assert delete_response.status_code == 403 # Forbidden

def test_delete_post_not_logged_in(client):
    """Test attempting to delete a post without being logged in."""
    # 1. Register, Login, Create Post, Logout (to ensure post exists)
    client.post('/api/v1/register', json={'username': 'tempuser_del', 'email': 'temp_del@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'tempuser_del', 'password': 'p'})
    create_response = client.post('/api/v1/posts', data={'content': 'Exists briefly', 'privacy': 'PUBLIC'})
    assert create_response.status_code == 201
    created_post_id = create_response.get_json()['post']['id']
    client.post('/api/v1/logout') # Corrected Logout

    # 2. Attempt delete while logged out
    delete_response = client.delete(f'/api/v1/posts/{created_post_id}')
    assert delete_response.status_code == 401 # Expect 401

def test_update_post_success(client):
    """Test updating a post successfully by its author."""
    # 1. Register, Login, Create Post
    client.post('/api/v1/register', json={'username': 'updateuser', 'email': 'update@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'updateuser', 'password': 'p'})
    create_response = client.post('/api/v1/posts', data={'content': 'Original content', 'privacy': 'PUBLIC'})
    assert create_response.status_code == 201
    created_post_id = create_response.get_json()['post']['id']

    # 2. Update the post (content and privacy)
    updated_content = "Updated post content!"
    updated_privacy = "FRIENDS"
    update_response = client.put(
        f'/api/v1/posts/{created_post_id}',
        json={
            'content': updated_content,
            'privacy': updated_privacy
        }
    )
    assert update_response.status_code == 200
    update_data = update_response.get_json()
    assert update_data['id'] == created_post_id
    assert update_data['content'] == updated_content
    assert update_data['privacy'] == updated_privacy
    assert update_data['author']['username'] == 'updateuser'

    # 3. Verify update by fetching the post again
    get_response = client.get(f'/api/v1/posts/{created_post_id}')
    assert get_response.status_code == 200
    get_data = get_response.get_json()
    assert get_data['content'] == updated_content
    assert get_data['privacy'] == updated_privacy

def test_update_post_unauthorized(client):
    """Test attempting to update a post by a non-author."""
    # 1. Register User A and User B
    client.post('/api/v1/register', json={'username': 'authoruser_upd', 'email': 'author_upd@example.com', 'password': 'p'})
    client.post('/api/v1/register', json={'username': 'otheruser_upd', 'email': 'other_upd@example.com', 'password': 'p'})

    # 2. User A logs in and creates a post
    client.post('/api/v1/login', json={'identifier': 'authoruser_upd', 'password': 'p'})
    create_response = client.post('/api/v1/posts', data={'content': 'Authors post to update', 'privacy': 'PUBLIC'})
    assert create_response.status_code == 201
    created_post_id = create_response.get_json()['post']['id']
    client.delete('/api/v1/login') # Log out User A

    # 3. User B logs in and tries to update User A's post
    client.post('/api/v1/login', json={'identifier': 'otheruser_upd', 'password': 'p'})
    update_response = client.put(
        f'/api/v1/posts/{created_post_id}',
        json={'content': 'Malicious update'}
    )
    assert update_response.status_code == 403 # Forbidden

def test_update_post_not_logged_in(client):
    """Test attempting to update a post without being logged in."""
    # 1. Register, Login, Create Post, Logout (to ensure post exists)
    client.post('/api/v1/register', json={'username': 'tempuser_upd', 'email': 'temp_upd@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'tempuser_upd', 'password': 'p'})
    create_response = client.post('/api/v1/posts', data={'content': 'Exists briefly upd', 'privacy': 'PUBLIC'})
    assert create_response.status_code == 201
    created_post_id = create_response.get_json()['post']['id']
    client.post('/api/v1/logout') # Corrected Logout

    # 2. Attempt update while logged out
    update_response = client.put(
        f'/api/v1/posts/{created_post_id}',
        json={'content': 'Update while logged out'}
    )
    assert update_response.status_code == 401 # Expect 401

def test_update_post_not_found(client):
    """Test attempting to update a non-existent post."""
    # Need to be logged in
    client.post('/api/v1/register', json={'username': 'updateuser_nf', 'email': 'update_nf@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'updateuser_nf', 'password': 'p'})

    update_response = client.put(
        f'/api/v1/posts/99999',
        json={'content': 'Update non-existent'}
    )
    assert update_response.status_code == 404 # Not Found

# --- Comment Tests ---

def test_create_comment_success(client):
    """Test creating a comment successfully."""
    # 1. Setup: User A registers, logs in, creates a post
    client.post('/api/v1/register', json={'username': 'commenter', 'email': 'commenter@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'commenter', 'password': 'p'})
    create_post_resp = client.post('/api/v1/posts', data={'content': 'Post to be commented on', 'privacy': 'PUBLIC'})
    assert create_post_resp.status_code == 201
    post_id = create_post_resp.get_json()['post']['id']

    # 2. Create comment
    comment_content = "This is a great post!"
    create_comment_resp = client.post(
        f'/api/v1/posts/{post_id}/comments',
        json={'content': comment_content}
    )
    assert create_comment_resp.status_code == 201
    comment_data = create_comment_resp.get_json()
    assert 'id' in comment_data
    assert comment_data['content'] == comment_content
    assert comment_data['post_id'] == post_id
    assert comment_data['author']['username'] == 'commenter'

def test_create_comment_unauthorized(client):
    """Test creating a comment fails if not logged in."""
    # 1. Setup: Create a post (user doesn't need to stay logged in)
    client.post('/api/v1/register', json={'username': 'post_owner_cmt', 'email': 'poc@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'post_owner_cmt', 'password': 'p'})
    create_post_resp = client.post('/api/v1/posts', data={'content': 'Post for unauthorized comment', 'privacy': 'PUBLIC'})
    assert create_post_resp.status_code == 201
    post_id = create_post_resp.get_json()['post']['id']
    client.post('/api/v1/logout') # Corrected Log out

    # 2. Attempt comment while logged out
    create_comment_resp = client.post(
        f'/api/v1/posts/{post_id}/comments',
        json={'content': 'Should fail'}
    )
    assert create_comment_resp.status_code == 401 # Expect 401

def test_create_comment_post_not_found(client):
    """Test creating a comment on a non-existent post."""
    # 1. Login
    client.post('/api/v1/register', json={'username': 'commenter_nf', 'email': 'commenter_nf@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'commenter_nf', 'password': 'p'})

    # 2. Attempt comment on non-existent post
    create_comment_resp = client.post(
        f'/api/v1/posts/99999/comments',
        json={'content': 'On nothing'}
    )
    assert create_comment_resp.status_code == 404

def test_delete_comment_success(client):
    """Test deleting a comment successfully by its author."""
    # 1. Setup: User registers, logs in, creates post, creates comment
    client.post('/api/v1/register', json={'username': 'comment_deleter', 'email': 'cd@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'comment_deleter', 'password': 'p'})
    create_post_resp = client.post('/api/v1/posts', data={'content': 'Post with comment to delete', 'privacy': 'PUBLIC'})
    post_id = create_post_resp.get_json()['post']['id']
    create_comment_resp = client.post(f'/api/v1/posts/{post_id}/comments', json={'content': 'To be deleted'})
    assert create_comment_resp.status_code == 201
    comment_id = create_comment_resp.get_json()['id']

    # 2. Delete the comment
    delete_comment_resp = client.delete(f'/api/v1/comments/{comment_id}')
    assert delete_comment_resp.status_code == 200
    assert delete_comment_resp.get_json()['message'] == 'Comment deleted successfully'

    # 3. Verify deletion (e.g., try deleting again, should be 404)
    verify_delete_resp = client.delete(f'/api/v1/comments/{comment_id}')
    assert verify_delete_resp.status_code == 404

def test_delete_comment_unauthorized_non_author(client):
    """Test deleting a comment by someone other than the author."""
    # 1. Setup: User A creates post, User B comments, User C tries to delete
    client.post('/api/v1/register', json={'username': 'comment_author', 'email': 'ca@example.com', 'password': 'p'})
    client.post('/api/v1/register', json={'username': 'comment_deleter_other', 'email': 'cdo@example.com', 'password': 'p'})
    client.post('/api/v1/register', json={'username': 'post_author_cd', 'email': 'pacd@example.com', 'password': 'p'})
    
    # Post Author logs in, creates post
    client.post('/api/v1/login', json={'identifier': 'post_author_cd', 'password': 'p'})
    create_post_resp = client.post('/api/v1/posts', data={'content': 'Post for multi user comment delete test', 'privacy': 'PUBLIC'})
    post_id = create_post_resp.get_json()['post']['id']
    client.delete('/api/v1/login') # Logout post author

    # Comment Author logs in, creates comment
    client.post('/api/v1/login', json={'identifier': 'comment_author', 'password': 'p'})
    create_comment_resp = client.post(f'/api/v1/posts/{post_id}/comments', json={'content': 'User B comment'})
    assert create_comment_resp.status_code == 201
    comment_id = create_comment_resp.get_json()['id']
    client.delete('/api/v1/login') # Logout comment author

    # Other User logs in, tries to delete comment
    client.post('/api/v1/login', json={'identifier': 'comment_deleter_other', 'password': 'p'})
    delete_comment_resp = client.delete(f'/api/v1/comments/{comment_id}')
    assert delete_comment_resp.status_code == 403 # Forbidden

def test_delete_comment_unauthorized_post_author(client):
    """Test deleting a comment by the post author (if not allowed)."""
    # Assuming only comment author can delete, not post author
    # 1. Setup: User A creates post, User B comments
    client.post('/api/v1/register', json={'username': 'comment_author_pa', 'email': 'capa@example.com', 'password': 'p'})
    client.post('/api/v1/register', json={'username': 'post_author_pa', 'email': 'papa@example.com', 'password': 'p'})
    
    # Post Author logs in, creates post
    client.post('/api/v1/login', json={'identifier': 'post_author_pa', 'password': 'p'})
    create_post_resp = client.post('/api/v1/posts', data={'content': 'Post for PA delete test', 'privacy': 'PUBLIC'})
    post_id = create_post_resp.get_json()['post']['id']
    # Stay logged in as post author

    # Comment Author logs in, creates comment
    client.delete('/api/v1/login') # Logout post author
    client.post('/api/v1/login', json={'identifier': 'comment_author_pa', 'password': 'p'})
    create_comment_resp = client.post(f'/api/v1/posts/{post_id}/comments', json={'content': 'User B comment for PA test'})
    assert create_comment_resp.status_code == 201
    comment_id = create_comment_resp.get_json()['id']
    client.delete('/api/v1/login') # Logout comment author

    # Post Author logs back in, tries to delete comment
    client.post('/api/v1/login', json={'identifier': 'post_author_pa', 'password': 'p'})
    delete_comment_resp = client.delete(f'/api/v1/comments/{comment_id}')
    # Check the specific permission logic - assuming 403 if only author can delete
    assert delete_comment_resp.status_code == 403 # Forbidden

def test_delete_comment_not_found(client):
    """Test deleting a non-existent comment."""
    # Login first
    client.post('/api/v1/register', json={'username': 'comment_deleter_nf', 'email': 'cdnf@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'comment_deleter_nf', 'password': 'p'})

    delete_comment_resp = client.delete(f'/api/v1/comments/99999')
    assert delete_comment_resp.status_code == 404

def test_delete_comment_not_logged_in(client):
    """Test deleting a comment fails if not logged in."""
    # 1. Setup: Create user, post, comment
    client.post('/api/v1/register', json={'username': 'comment_owner_del_nli', 'email': 'codn@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'comment_owner_del_nli', 'password': 'p'})
    create_post_resp = client.post('/api/v1/posts', data={'content': 'Post NLI', 'privacy': 'PUBLIC'})
    post_id = create_post_resp.get_json()['post']['id']
    create_comment_resp = client.post(f'/api/v1/posts/{post_id}/comments', json={'content': 'Comment NLI'})
    assert create_comment_resp.status_code == 201
    comment_id = create_comment_resp.get_json()['id']
    client.post('/api/v1/logout') # Corrected Logout

    # 2. Attempt delete while logged out
    delete_comment_resp = client.delete(f'/api/v1/comments/{comment_id}')
    assert delete_comment_resp.status_code == 401 # Expect 401

# --- Profile Tests ---

def test_get_own_profile_success(client):
    """Test fetching the logged-in user's own profile."""
    # 1. Register and Login
    client.post('/api/v1/register', json={'username': 'profileowner', 'email': 'po@example.com', 'password': 'p'})
    login_resp = client.post('/api/v1/login', json={'identifier': 'profileowner', 'password': 'p'})
    assert login_resp.status_code == 200

    # 2. Fetch own profile
    profile_resp = client.get('/api/v1/profiles/profileowner')
    assert profile_resp.status_code == 200
    profile_data = profile_resp.get_json()

    # Check structure and basic data
    assert 'user' in profile_data
    assert profile_data['user']['username'] == 'profileowner'
    assert profile_data['user']['email'] == 'po@example.com' # Own profile should show email
    assert 'posts' in profile_data
    assert isinstance(profile_data['posts'], list)
    assert 'interests' in profile_data
    assert isinstance(profile_data['interests'], list)
    assert profile_data['friendship_status'] == 'SELF'

def test_get_other_user_profile_success(client):
    """Test fetching another user's public profile."""
    # 1. Register User A (profile owner) and User B (viewer)
    client.post('/api/v1/register', json={'username': 'profileowner_other', 'email': 'poo@example.com', 'password': 'p'})
    client.post('/api/v1/register', json={'username': 'profileviewer', 'email': 'pv@example.com', 'password': 'p'})

    # 2. User A creates a public post (optional, but good to check posts list)
    client.post('/api/v1/login', json={'identifier': 'profileowner_other', 'password': 'p'})
    client.post('/api/v1/posts', data={'content': 'Public post by profileowner_other', 'privacy': 'PUBLIC'})
    client.delete('/api/v1/login') # Logout User A

    # 3. User B logs in and fetches User A's profile
    client.post('/api/v1/login', json={'identifier': 'profileviewer', 'password': 'p'})
    profile_resp = client.get('/api/v1/profiles/profileowner_other')
    assert profile_resp.status_code == 200
    profile_data = profile_resp.get_json()

    assert 'user' in profile_data
    assert profile_data['user']['username'] == 'profileowner_other'
    # Email might be hidden for other users - check resource logic if needed
    # assert 'email' not in profile_data['user'] or profile_data['user']['email'] is None
    assert 'posts' in profile_data
    assert len(profile_data['posts']) >= 1 # Should see the public post
    assert profile_data['posts'][0]['content'] == 'Public post by profileowner_other'
    assert 'interests' in profile_data
    assert profile_data['friendship_status'] == 'NONE' # Not friends yet

def test_get_profile_not_logged_in(client):
    """Test fetching a profile fails if not logged in."""
    # 1. Register a user whose profile we want to view
    client.post('/api/v1/register', json={'username': 'profile_exists', 'email': 'pe@example.com', 'password': 'p'})
    
    # Ensure no user is logged in from previous tests (belt and suspenders)
    client.delete('/api/v1/login') 

    # 2. Attempt to fetch profile
    profile_resp = client.get('/api/v1/profiles/profile_exists')
    assert profile_resp.status_code == 401 # Expect 401

def test_get_profile_not_found(client):
    """Test fetching a profile for a non-existent user."""
    # 1. Login as some user
    client.post('/api/v1/register', json={'username': 'fetcher_nf', 'email': 'fnf@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'fetcher_nf', 'password': 'p'})

    # 2. Attempt to fetch non-existent profile
    profile_resp = client.get('/api/v1/profiles/nosuchuserprofile')
    assert profile_resp.status_code == 404

# Add tests later for profile visibility with friends, friends-only posts etc.

# Add more tests later for getting specific post, updating, deleting, privacy etc.

# --- Friend Request Tests ---

def test_send_friend_request_success(client):
    """Test successfully sending a friend request."""
    # 1. Register User A (sender) and User B (receiver)
    reg_a = client.post('/api/v1/register', json={'username': 'sender_fr', 'email': 'sender_fr@example.com', 'password': 'p'})
    user_a_id = reg_a.get_json()['user_id']
    reg_b = client.post('/api/v1/register', json={'username': 'receiver_fr', 'email': 'receiver_fr@example.com', 'password': 'p'})
    user_b_id = reg_b.get_json()['user_id']

    # 2. User A logs in
    login_resp = client.post('/api/v1/login', json={'identifier': 'sender_fr', 'password': 'p'})
    assert login_resp.status_code == 200

    # 3. User A sends request to User B
    send_req_resp = client.post('/api/v1/friend-requests', json={'user_id': user_b_id})
    assert send_req_resp.status_code == 201
    req_data = send_req_resp.get_json()
    assert 'id' in req_data
    assert req_data['sender']['id'] == user_a_id
    assert req_data['receiver']['id'] == user_b_id
    assert req_data['status'] == 'PENDING'

def test_send_friend_request_to_self(client):
    """Test sending a friend request to oneself fails."""
    # 1. Register and Login
    reg_a = client.post('/api/v1/register', json={'username': 'self_fr', 'email': 'self_fr@example.com', 'password': 'p'})
    user_a_id = reg_a.get_json()['user_id']
    login_resp = client.post('/api/v1/login', json={'identifier': 'self_fr', 'password': 'p'})
    assert login_resp.status_code == 200

    # 2. Attempt sending request to self
    send_req_resp = client.post('/api/v1/friend-requests', json={'user_id': user_a_id})
    assert send_req_resp.status_code == 400 # Bad Request

def test_send_friend_request_duplicate(client):
    """Test sending a duplicate friend request fails."""
    # 1. Setup users and send initial request
    reg_a = client.post('/api/v1/register', json={'username': 'sender_fr_dup', 'email': 'sender_fr_dup@example.com', 'password': 'p'})
    user_a_id = reg_a.get_json()['user_id']
    reg_b = client.post('/api/v1/register', json={'username': 'receiver_fr_dup', 'email': 'receiver_fr_dup@example.com', 'password': 'p'})
    user_b_id = reg_b.get_json()['user_id']
    client.post('/api/v1/login', json={'identifier': 'sender_fr_dup', 'password': 'p'})
    client.post('/api/v1/friend-requests', json={'user_id': user_b_id}) # First request

    # 2. Attempt sending duplicate request
    send_req_resp = client.post('/api/v1/friend-requests', json={'user_id': user_b_id})
    assert send_req_resp.status_code == 400 # Bad Request (or Conflict 409? Check resource)
    # Check error message if possible

def test_send_friend_request_not_logged_in(client):
    """Test sending a friend request fails if not logged in."""
    # 1. Setup receiver user
    reg_b = client.post('/api/v1/register', json={'username': 'receiver_fr_nli', 'email': 'receiver_fr_nli@example.com', 'password': 'p'})
    user_b_id = reg_b.get_json()['user_id']
    # Do not log in

    # 2. Attempt sending request
    send_req_resp = client.post('/api/v1/friend-requests', json={'user_id': user_b_id})
    # Expect 401 Unauthorized as endpoint is @login_required
    assert send_req_resp.status_code == 401

def test_list_friend_requests_success(client):
    """Test listing received pending friend requests."""
    # 1. Setup users
    reg_sender = client.post('/api/v1/register', json={'username': 'sender_list', 'email': 'sender_list@example.com', 'password': 'p'})
    sender_id = reg_sender.get_json()['user_id']
    reg_receiver = client.post('/api/v1/register', json={'username': 'receiver_list', 'email': 'receiver_list@example.com', 'password': 'p'})
    receiver_id = reg_receiver.get_json()['user_id']

    # 2. Sender logs in and sends request to Receiver
    client.post('/api/v1/login', json={'identifier': 'sender_list', 'password': 'p'})
    send_resp = client.post('/api/v1/friend-requests', json={'user_id': receiver_id})
    request_id = send_resp.get_json()['id']
    client.delete('/api/v1/login') # Logout sender

    # 3. Receiver logs in
    client.post('/api/v1/login', json={'identifier': 'receiver_list', 'password': 'p'})

    # 4. Receiver lists pending requests
    list_resp = client.get('/api/v1/friend-requests')
    assert list_resp.status_code == 200
    requests_data = list_resp.get_json()
    assert isinstance(requests_data, list)
    assert len(requests_data) == 1
    assert requests_data[0]['id'] == request_id
    assert requests_data[0]['sender']['id'] == sender_id
    assert requests_data[0]['receiver']['id'] == receiver_id
    assert requests_data[0]['status'] == 'PENDING'

def test_list_friend_requests_empty(client):
    """Test listing requests when none are pending."""
    # 1. Register and Login
    client.post('/api/v1/register', json={'username': 'receiver_empty', 'email': 'receiver_empty@example.com', 'password': 'p'})
    client.post('/api/v1/login', json={'identifier': 'receiver_empty', 'password': 'p'})

    # 2. List requests
    list_resp = client.get('/api/v1/friend-requests')
    assert list_resp.status_code == 200
    requests_data = list_resp.get_json()
    assert isinstance(requests_data, list)
    assert len(requests_data) == 0

def test_list_friend_requests_not_logged_in(client):
    """Test listing requests fails if not logged in."""
    list_resp = client.get('/api/v1/friend-requests')
    # Expect 401 Unauthorized as endpoint is @login_required
    assert list_resp.status_code == 401

def test_accept_friend_request_success(client):
    """Test accepting a friend request successfully."""
    # 1. Setup: Sender sends request to Receiver
    reg_a = client.post('/api/v1/register', json={'username': 'sender_acc', 'email': 'sender_acc@example.com', 'password': 'p'})
    reg_b = client.post('/api/v1/register', json={'username': 'receiver_acc', 'email': 'receiver_acc@example.com', 'password': 'p'})
    user_b_id = reg_b.get_json()['user_id']
    client.post('/api/v1/login', json={'identifier': 'sender_acc', 'password': 'p'})
    send_resp = client.post('/api/v1/friend-requests', json={'user_id': user_b_id})
    request_id = send_resp.get_json()['id']
    client.delete('/api/v1/login') # Logout sender

    # 2. Receiver logs in
    client.post('/api/v1/login', json={'identifier': 'receiver_acc', 'password': 'p'})

    # 3. Receiver accepts the request via PUT
    accept_resp = client.put(f'/api/v1/friend-requests/{request_id}', json={'action': 'accept'})
    assert accept_resp.status_code == 200
    accept_data = accept_resp.get_json()
    assert accept_data['id'] == request_id
    assert accept_data['status'] == 'ACCEPTED'

def test_reject_friend_request_success(client):
    """Test rejecting a friend request successfully."""
    # 1. Setup: Sender sends request to Receiver
    reg_a = client.post('/api/v1/register', json={'username': 'sender_rej', 'email': 'sender_rej@example.com', 'password': 'p'})
    reg_b = client.post('/api/v1/register', json={'username': 'receiver_rej', 'email': 'receiver_rej@example.com', 'password': 'p'})
    user_b_id = reg_b.get_json()['user_id']
    client.post('/api/v1/login', json={'identifier': 'sender_rej', 'password': 'p'})
    send_resp = client.post('/api/v1/friend-requests', json={'user_id': user_b_id})
    request_id = send_resp.get_json()['id']
    client.delete('/api/v1/login') # Logout sender

    # 2. Receiver logs in
    client.post('/api/v1/login', json={'identifier': 'receiver_rej', 'password': 'p'})

    # 3. Receiver rejects the request via PUT
    # NOTE: The resource currently DELETES on reject. If changed to set status, update test.
    reject_resp = client.put(f'/api/v1/friend-requests/{request_id}', json={'action': 'reject'})
    assert reject_resp.status_code == 200 
    # Assuming reject returns the modified (or deleted) request details or a success message
    # If it deletes, subsequent GET on the request ID should 404.
    # Let's check the resource code again if this fails.
    # For now, assume it returns the object with status change (if implemented) or just 200 OK on delete.

    # Verify: Listing requests should now be empty
    list_resp = client.get('/api/v1/friend-requests')
    assert len(list_resp.get_json()) == 0

def test_cancel_sent_request_success(client):
    """Test canceling a sent friend request successfully."""
    # 1. Setup: Sender sends request to Receiver
    reg_a = client.post('/api/v1/register', json={'username': 'sender_can', 'email': 'sender_can@example.com', 'password': 'p'})
    reg_b = client.post('/api/v1/register', json={'username': 'receiver_can', 'email': 'receiver_can@example.com', 'password': 'p'})
    user_b_id = reg_b.get_json()['user_id']
    client.post('/api/v1/login', json={'identifier': 'sender_can', 'password': 'p'})
    send_resp = client.post('/api/v1/friend-requests', json={'user_id': user_b_id})
    request_id = send_resp.get_json()['id']
    # Stay logged in as sender

    # 2. Sender cancels the request via DELETE
    cancel_resp = client.delete(f'/api/v1/friend-requests/{request_id}')
    assert cancel_resp.status_code == 200
    assert cancel_resp.get_json()['message'] == 'Friend request canceled'

    # 3. Verify: Receiver logs in and sees no pending requests
    client.delete('/api/v1/login') # Logout sender
    client.post('/api/v1/login', json={'identifier': 'receiver_can', 'password': 'p'})
    list_resp = client.get('/api/v1/friend-requests')
    assert len(list_resp.get_json()) == 0

def test_manage_friend_request_unauthorized(client):
    """Test accepting/rejecting/canceling fails if not logged in."""
    # 1. Setup: Sender sends request to Receiver
    reg_a = client.post('/api/v1/register', json={'username': 'sender_mng_nli', 'email': 'sender_mng_nli@example.com', 'password': 'p'})
    reg_b = client.post('/api/v1/register', json={'username': 'receiver_mng_nli', 'email': 'receiver_mng_nli@example.com', 'password': 'p'})
    user_b_id = reg_b.get_json()['user_id']
    client.post('/api/v1/login', json={'identifier': 'sender_mng_nli', 'password': 'p'})
    send_resp = client.post('/api/v1/friend-requests', json={'user_id': user_b_id})
    request_id = send_resp.get_json()['id']
    client.post('/api/v1/logout') # Corrected Logout sender

    # 2. Attempt actions while logged out
    put_resp = client.put(f'/api/v1/friend-requests/{request_id}', json={'action': 'accept'})
    assert put_resp.status_code == 401 # Expect 401

    # Attempt another action (e.g., reject)
    put_resp_reject = client.put(f'/api/v1/friend-requests/{request_id}', json={'action': 'reject'})
    assert put_resp_reject.status_code == 401 # Expect 401

    # Attempt to cancel (which might be a DELETE or another PUT action depending on API design)
    # For this test, let's assume cancelling by sender would also be a PUT with action 'cancel'
    # or that the request is still there and any PUT by a logged-out user is 401.
    # Re-login as sender to attempt cancel, then logout, then try PUT again as anonymous.
    # This part is more about ensuring the state after failed anonymous PUTs.
    # The primary check is that PUT results in 401 if not logged in.

def test_manage_friend_request_wrong_user(client):
    """Test accepting/rejecting/canceling request not involving current user fails."""
    # 1. Setup: Sender A -> Receiver B, User C exists
    reg_a = client.post('/api/v1/register', json={'username': 'sender_wrong', 'email': 'sender_wrong@example.com', 'password': 'p'})
    reg_b = client.post('/api/v1/register', json={'username': 'receiver_wrong', 'email': 'receiver_wrong@example.com', 'password': 'p'})
    user_b_id = reg_b.get_json()['user_id']
    client.post('/api/v1/register', json={'username': 'other_wrong', 'email': 'other_wrong@example.com', 'password': 'p'})

    # Sender A sends request
    client.post('/api/v1/login', json={'identifier': 'sender_wrong', 'password': 'p'})
    send_resp = client.post('/api/v1/friend-requests', json={'user_id': user_b_id})
    request_id = send_resp.get_json()['id']
    client.delete('/api/v1/login') # Logout sender A

    # 2. User C logs in and tries to manage the request
    client.post('/api/v1/login', json={'identifier': 'other_wrong', 'password': 'p'})
    
    # Try accepting (PUT)
    put_resp = client.put(f'/api/v1/friend-requests/{request_id}', json={'action': 'accept'})
    assert put_resp.status_code == 403 # Forbidden

    # Try canceling (DELETE)
    del_resp = client.delete(f'/api/v1/friend-requests/{request_id}')
    assert del_resp.status_code == 403 # Forbidden 

# --- Unfriend Test ---

def test_unfriend_success(client):
    """Test successfully unfriending a user."""
    # 1. Setup: User A and B become friends
    reg_a = client.post('/api/v1/register', json={'username': 'user_a_unf', 'email': 'a_unf@example.com', 'password': 'p'})
    user_a_id = reg_a.get_json()['user_id']
    reg_b = client.post('/api/v1/register', json={'username': 'user_b_unf', 'email': 'b_unf@example.com', 'password': 'p'})
    user_b_id = reg_b.get_json()['user_id']
    
    # A sends request to B
    client.post('/api/v1/login', json={'identifier': 'user_a_unf', 'password': 'p'})
    send_resp = client.post('/api/v1/friend-requests', json={'user_id': user_b_id})
    request_id = send_resp.get_json()['id']
    client.delete('/api/v1/login') 

    # B accepts request
    client.post('/api/v1/login', json={'identifier': 'user_b_unf', 'password': 'p'})
    client.put(f'/api/v1/friend-requests/{request_id}', json={'action': 'accept'})
    client.delete('/api/v1/login')

    # 2. User A logs back in
    client.post('/api/v1/login', json={'identifier': 'user_a_unf', 'password': 'p'})

    # 3. User A unfriends User B using DELETE /friendships/<user_id>
    unfriend_resp = client.delete(f'/api/v1/friendships/{user_b_id}')
    assert unfriend_resp.status_code == 200
    assert 'Successfully unfriended' in unfriend_resp.get_json()['message']

    # 4. Verify: Fetch profile of User B, friendship_status should be NONE
    profile_resp = client.get(f'/api/v1/profiles/user_b_unf')
    assert profile_resp.status_code == 200
    assert profile_resp.get_json()['friendship_status'] == 'NONE'

def test_unfriend_not_friends(client):
    """Test attempting to unfriend someone you are not friends with."""
    # 1. Setup users
    reg_a = client.post('/api/v1/register', json={'username': 'user_a_unf_nf', 'email': 'a_unf_nf@example.com', 'password': 'p'})
    reg_b = client.post('/api/v1/register', json={'username': 'user_b_unf_nf', 'email': 'b_unf_nf@example.com', 'password': 'p'})
    user_b_id = reg_b.get_json()['user_id']

    # 2. User A logs in
    client.post('/api/v1/login', json={'identifier': 'user_a_unf_nf', 'password': 'p'})

    # 3. User A tries to unfriend User B (they are not friends)
    unfriend_resp = client.delete(f'/api/v1/friendships/{user_b_id}')
    assert unfriend_resp.status_code == 400 # Bad Request expected from resource
    assert 'Could not unfriend user' in unfriend_resp.get_json()['message']

def test_unfriend_self(client):
    """Test attempting to unfriend yourself."""
    # 1. Register and Login
    reg_a = client.post('/api/v1/register', json={'username': 'user_a_unf_self', 'email': 'a_unf_self@example.com', 'password': 'p'})
    user_a_id = reg_a.get_json()['user_id']
    client.post('/api/v1/login', json={'identifier': 'user_a_unf_self', 'password': 'p'})

    # 2. Attempt to unfriend self
    unfriend_resp = client.delete(f'/api/v1/friendships/{user_a_id}')
    assert unfriend_resp.status_code == 400 # Bad Request
    assert 'Cannot unfriend yourself' in unfriend_resp.get_json()['message']

def test_unfriend_not_logged_in(client):
    """Test unfriending fails if not logged in."""
     # 1. Setup users (no need to make them friends)
    reg_a = client.post('/api/v1/register', json={'username': 'user_a_unf_nli', 'email': 'a_unf_nli@example.com', 'password': 'p'})
    reg_b = client.post('/api/v1/register', json={'username': 'user_b_unf_nli', 'email': 'b_unf_nli@example.com', 'password': 'p'})
    user_b_id = reg_b.get_json()['user_id']
    # Don't log in

    # 2. Attempt unfriend
    unfriend_resp = client.delete(f'/api/v1/friendships/{user_b_id}')
    # Expect 401 Unauthorized as endpoint is @login_required
    assert unfriend_resp.status_code == 401

# --- Feed Tests ---

def test_get_feed_success(client):
    """Test fetching the feed successfully when logged in."""
    # 1. Register and Login
    client.post('/api/v1/register', json={'username': 'feeduser', 'email': 'feed@example.com', 'password': 'p'})
    login_resp = client.post('/api/v1/login', json={'identifier': 'feeduser', 'password': 'p'})
    assert login_resp.status_code == 200

    # 2. Fetch feed
    feed_resp = client.get('/api/v1/feed')
    assert feed_resp.status_code == 200
    feed_data = feed_resp.get_json()

    # Check basic structure
    assert 'posts' in feed_data
    assert isinstance(feed_data['posts'], list)
    assert 'page' in feed_data
    assert 'per_page' in feed_data
    assert 'total_items' in feed_data
    assert 'total_pages' in feed_data
    # Message might be None or present depending on logic
    assert 'message' in feed_data 

def test_get_feed_not_logged_in(client):
    """Test fetching the feed fails if not logged in."""
    feed_resp = client.get('/api/v1/feed')
    # Expect 401 Unauthorized as endpoint is @login_required
    assert feed_resp.status_code == 401

# TODO: Add more complex feed tests: 
# - Feed content with friends' posts
# - Feed content with personalized posts based on interests
# - Feed pagination
# - Feed excluding own posts
# - Feed excluding blocked categories

# --- Invite Tests ---

def test_list_invites_success(client):
    """Test listing invites successfully (initially none)."""
    # 1. Register and Login
    client.post('/api/v1/register', json={'username': 'inviteuser', 'email': 'inv@example.com', 'password': 'p'})
    login_resp = client.post('/api/v1/login', json={'identifier': 'inviteuser', 'password': 'p'})
    assert login_resp.status_code == 200

    # 2. List invites
    list_resp = client.get('/api/v1/invites')
    assert list_resp.status_code == 200
    list_data = list_resp.get_json()

    assert 'unused_codes' in list_data
    assert isinstance(list_data['unused_codes'], list)
    assert len(list_data['unused_codes']) == 0
    assert 'used_codes' in list_data
    assert isinstance(list_data['used_codes'], list)
    assert len(list_data['used_codes']) == 0
    assert 'invites_left' in list_data
    assert list_data['invites_left'] == 3 # Default invites

def test_generate_invite_success(client):
    """Test generating a new invite code successfully."""
    # 1. Register and Login
    client.post('/api/v1/register', json={'username': 'invitegen', 'email': 'invgen@example.com', 'password': 'p'})
    login_resp = client.post('/api/v1/login', json={'identifier': 'invitegen', 'password': 'p'})
    user_id = login_resp.get_json()['user']['id']
    assert login_resp.status_code == 200

    # 2. Generate invite code via POST
    gen_resp = client.post('/api/v1/invites')
    assert gen_resp.status_code == 201
    gen_data = gen_resp.get_json()
    assert 'id' in gen_data
    assert 'code' in gen_data
    assert gen_data['is_used'] == False
    assert gen_data['issuer_id'] == user_id
    invite_code = gen_data['code']

    # 3. List invites again, check counts and new code
    list_resp = client.get('/api/v1/invites')
    assert list_resp.status_code == 200
    list_data = list_resp.get_json()
    assert list_data['invites_left'] == 2 # Invites decremented
    assert len(list_data['unused_codes']) == 1
    assert list_data['unused_codes'][0]['code'] == invite_code
    assert len(list_data['used_codes']) == 0

def test_generate_invite_no_invites_left(client):
    """Test generating invite fails when none are left."""
    # 1. Register and Login
    client.post('/api/v1/register', json={'username': 'noinvites', 'email': 'noinv@example.com', 'password': 'p'})
    login_resp = client.post('/api/v1/login', json={'identifier': 'noinvites', 'password': 'p'})
    assert login_resp.status_code == 200

    # 2. Generate invites until none left (default 3)
    for _ in range(3):
        gen_resp = client.post('/api/v1/invites')
        assert gen_resp.status_code == 201
    
    # 3. Verify invites left is 0
    list_resp = client.get('/api/v1/invites')
    assert list_resp.get_json()['invites_left'] == 0

    # 4. Attempt to generate one more
    gen_resp_fail = client.post('/api/v1/invites')
    assert gen_resp_fail.status_code == 400 # Bad Request
    assert gen_resp_fail.get_json()['message'] == 'No invites left to generate'

def test_invite_endpoints_not_logged_in(client):
    """Test GET and POST invite endpoints fail if not logged in."""
    list_resp = client.get('/api/v1/invites')
    # Expect 401 Unauthorized as endpoint is @login_required
    assert list_resp.status_code == 401
    
    gen_resp = client.post('/api/v1/invites')
    # Expect 401 Unauthorized as endpoint is @login_required
    assert gen_resp.status_code == 401

# --- End of File ---