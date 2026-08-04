import pytest
import json # Import json for json.loads
from flask import jsonify
from models import db, User, Post, Comment, Ampersound, Report
from models import UserType, ReportContentType, ReportStatus, PostPrivacy, CommentVisibility

# Fixtures are defined in conftest.py
# Expected: client, create_user, create_post, create_comment, create_ampersound
# Expected: regular_user_auth_data, admin_user_auth_data


def test_report_unauthorized(client):
    """Test that an unauthenticated user cannot submit a report."""
    report_data = {
        'content_type': 'post',
        'content_id': 1,
        'reason': 'Test reason'
    }
    response = client.post('/api/v1/reports', json=report_data)
    assert response.status_code == 401 # Expect Unauthorized
    json_data = json.loads(response.data.decode('utf-8'))
    assert json_data['message'] == "Authentication required."

def test_report_own_post(client, create_user, create_post, regular_user_auth_data):
    """Test that a user cannot report their own post."""
    user_details = regular_user_auth_data # Contains {'headers': ..., 'user': user_object}
    current_user = user_details['user']
    auth_headers = user_details['headers']

    # Create a post by the current user
    own_post = create_post(user_id=current_user.id, content="My own post")
    db.session.commit() # Ensure post is committed and has an ID

    report_data = {
        'content_type': 'post',
        'content_id': own_post.id,
        'reason': 'Trying to report myself'
    }
    response = client.post('/api/v1/reports', json=report_data)
    
    assert response.status_code == 400 # Expect Bad Request
    json_data = response.get_json()
    assert json_data['message'] == "You cannot report your own content."

def test_report_missing_content_type(client, regular_user_auth_data):
    """Test reporting with a missing content_type field."""
    auth_headers = regular_user_auth_data['headers']
    report_data = {
        # 'content_type': 'post', # Missing
        'content_id': 1,
        'reason': 'Test reason'
    }
    response = client.post('/api/v1/reports', json=report_data)
    assert response.status_code == 400 # Expect Bad Request
    json_data = response.get_json()
    # The actual message might depend on your reqparse setup, 
    # but it should indicate a missing/invalid field.
    assert 'content_type' in json_data['message'] # or a more specific message check

def test_report_missing_content_id(client, regular_user_auth_data):
    """Test reporting with a missing content_id field."""
    auth_headers = regular_user_auth_data['headers']
    report_data = {
        'content_type': 'post',
        # 'content_id': 1, # Missing
        'reason': 'Test reason'
    }
    response = client.post('/api/v1/reports', json=report_data)
    assert response.status_code == 400 # Expect Bad Request
    json_data = response.get_json()
    assert 'content_id' in json_data['message']

def test_report_invalid_content_type_value(client, regular_user_auth_data):
    """Test reporting with an invalid value for content_type."""
    auth_headers = regular_user_auth_data['headers']
    report_data = {
        'content_type': 'movie', # Invalid value
        'content_id': 1,
        'reason': 'Test reason'
    }
    response = client.post('/api/v1/reports', json=report_data)
    assert response.status_code == 400 # Expect Bad Request
    json_data = response.get_json()
    # When an invalid choice is provided, reqparse uses the 'help' string for that argument as the error message.
    expected_error_message_for_content_type = 'Type of content being reported (post, comment, ampersound)'
    assert json_data['message']['content_type'] == expected_error_message_for_content_type

def test_report_non_existent_post(client, regular_user_auth_data):
    """Test reporting a post that does not exist."""
    auth_headers = regular_user_auth_data['headers']
    report_data = {
        'content_type': 'post',
        'content_id': 99999, # Assuming this ID does not exist
        'reason': 'Test reason'
    }
    response = client.post('/api/v1/reports', json=report_data)
    assert response.status_code == 404 # Expect Not Found
    json_data = response.get_json()
    assert "Post with ID 99999 not found" in json_data['message']

def test_report_non_existent_comment(client, regular_user_auth_data):
    """Test reporting a comment that does not exist."""
    auth_headers = regular_user_auth_data['headers']
    report_data = {
        'content_type': 'comment',
        'content_id': 99999, # Assuming this ID does not exist
        'reason': 'Test reason'
    }
    response = client.post('/api/v1/reports', json=report_data)
    assert response.status_code == 404 # Expect Not Found
    json_data = response.get_json()
    assert "Comment with ID 99999 not found" in json_data['message']

def test_report_non_existent_ampersound(client, regular_user_auth_data):
    """Test reporting an ampersound that does not exist."""
    auth_headers = regular_user_auth_data['headers']
    report_data = {
        'content_type': 'ampersound',
        'content_id': 99999, # Assuming this ID does not exist
        'reason': 'Test reason'
    }
    response = client.post('/api/v1/reports', json=report_data)
    assert response.status_code == 404 # Expect Not Found
    json_data = response.get_json()
    assert "Ampersound with ID 99999 not found" in json_data['message']

def test_successful_report_post_by_regular_user(client, create_user, create_post, regular_user_auth_data):
    """Test a regular user successfully reporting another user's post."""
    reporter_details = regular_user_auth_data
    reporter_user = reporter_details['user']
    auth_headers = reporter_details['headers']

    # Create a different user whose content will be reported
    reported_user_instance = create_user(username='reportedUser', email='reported@example.com', password='password123')
    # Create a post by the reported_user_instance
    post_to_report = create_post(user_id=reported_user_instance.id, content="This is a post to be reported.")
    db.session.commit() # Ensure users and post are committed

    report_data = {
        'content_type': 'post',
        'content_id': post_to_report.id,
        'reason': 'This post is offensive.'
    }
    response = client.post('/api/v1/reports', json=report_data)
    
    assert response.status_code == 201
    json_data = response.get_json()
    assert 'Report submitted successfully' in json_data['message']
    assert 'report_id' in json_data

    # Verify the report in the database
    report_in_db = Report.query.get(json_data['report_id'])
    assert report_in_db is not None
    assert report_in_db.reporter_id == reporter_user.id
    assert report_in_db.reported_user_id == reported_user_instance.id
    assert report_in_db.content_type == ReportContentType.POST
    assert report_in_db.content_id == post_to_report.id
    assert report_in_db.reason == 'This post is offensive.'
    assert report_in_db.status == ReportStatus.PENDING

    # Verify that the reported post's privacy has NOT changed
    original_post = Post.query.get(post_to_report.id)
    assert original_post.privacy == PostPrivacy.PUBLIC  # create_post fixture still defaults to PUBLIC

def test_successful_report_comment_by_regular_user(client, create_user, create_post, create_comment, regular_user_auth_data):
    """Test a regular user successfully reporting another user's comment."""
    reporter_details = regular_user_auth_data
    reporter_user = reporter_details['user']
    auth_headers = reporter_details['headers']

    reported_user_instance = create_user(username='commenterUser', email='commenter@example.com', password='password123')
    # A post for the comment to belong to (can be by anyone, e.g., reporter or a third user)
    parent_post = create_post(user_id=reporter_user.id, content="A post for comments") 
    comment_to_report = create_comment(user_id=reported_user_instance.id, post_id=parent_post.id, content="This is an offensive comment.")
    db.session.commit()

    report_data = {
        'content_type': 'comment',
        'content_id': comment_to_report.id,
        'reason': 'This comment is inappropriate.'
    }
    response = client.post('/api/v1/reports', json=report_data)
    
    assert response.status_code == 201
    json_data = response.get_json()
    assert 'Report submitted successfully' in json_data['message']
    assert 'report_id' in json_data

    report_in_db = Report.query.get(json_data['report_id'])
    assert report_in_db is not None
    assert report_in_db.reporter_id == reporter_user.id
    assert report_in_db.reported_user_id == reported_user_instance.id
    assert report_in_db.content_type == ReportContentType.COMMENT
    assert report_in_db.content_id == comment_to_report.id
    assert report_in_db.reason == 'This comment is inappropriate.'
    assert report_in_db.status == ReportStatus.PENDING

def test_successful_report_ampersound_by_regular_user(client, create_user, create_ampersound, regular_user_auth_data):
    """Test a regular user successfully reporting another user's ampersound."""
    reporter_details = regular_user_auth_data
    reporter_user = reporter_details['user']
    auth_headers = reporter_details['headers']

    reported_user_instance = create_user(username='ampersoundOwner', email='ampsound@example.com', password='password123')
    ampersound_to_report = create_ampersound(user_id=reported_user_instance.id, name='offensiveSound', file_path='path/to/sound.mp3')
    db.session.commit()

    report_data = {
        'content_type': 'ampersound',
        'content_id': ampersound_to_report.id,
        'reason': 'This ampersound is problematic.'
    }
    response = client.post('/api/v1/reports', json=report_data)
    
    assert response.status_code == 201
    json_data = response.get_json()
    assert 'Report submitted successfully' in json_data['message']
    assert 'report_id' in json_data

    report_in_db = Report.query.get(json_data['report_id'])
    assert report_in_db is not None
    assert report_in_db.reporter_id == reporter_user.id
    assert report_in_db.reported_user_id == reported_user_instance.id
    assert report_in_db.content_type == ReportContentType.AMPERSOUND
    assert report_in_db.content_id == ampersound_to_report.id
    assert report_in_db.reason == 'This ampersound is problematic.'
    assert report_in_db.status == ReportStatus.PENDING

def test_duplicate_report_by_same_user(client, create_user, create_post, regular_user_auth_data):
    """Test that a user cannot report the same content multiple times."""
    reporter_details = regular_user_auth_data
    reporter_user = reporter_details['user']
    auth_headers = reporter_details['headers']

    reported_user_instance = create_user(username='anotherUser', email='another@example.com', password='password123')
    post_to_report = create_post(user_id=reported_user_instance.id, content="A post for duplicate reporting.")
    db.session.commit()

    report_data = {
        'content_type': 'post',
        'content_id': post_to_report.id,
        'reason': 'First report reason.'
    }
    # First report - should succeed
    response1 = client.post('/api/v1/reports', json=report_data)
    assert response1.status_code == 201
    report_id = response1.get_json()['report_id']
    
    # Attempt to report the same content again by the same user
    response2 = client.post('/api/v1/reports', json=report_data)
    assert response2.status_code == 409 # Expect Conflict
    json_data2 = response2.get_json()
    assert json_data2['message'] == "You have already reported this content."

def test_admin_report_on_post_restricts_all_user_content(
    client, 
    create_user, 
    create_post, 
    create_comment, 
    create_ampersound, 
    admin_user_auth_data # Fixture for a logged-in admin user
):
    """Test that an admin reporting a user's post restricts all that user's content."""
    admin_details = admin_user_auth_data
    # admin_user = admin_details['user'] # Not strictly needed for this test if we only use headers
    admin_headers = admin_details['headers']

    # Create the user whose content will be reported
    reported_user = create_user(username='UserToRestrict', email='restrictme@example.com', password='password123')
    
    # Create various pieces of content for the reported_user
    # Ensure these are initially public or whatever your default accessible state is
    post1_by_reported = create_post(user_id=reported_user.id, content="Public post 1", privacy=PostPrivacy.PUBLIC)
    post2_by_reported = create_post(user_id=reported_user.id, content="Public post 2", privacy=PostPrivacy.PUBLIC)
    
    # A parent post for the comment (can be by anyone, even the admin or a third user)
    # For simplicity, let's say it's by the admin or another user not being reported.
    comment_parent_post_user = create_user(username='CommentParentOwner', email='parent@example.com')
    comment_parent_post = create_post(user_id=comment_parent_post_user.id, content="Parent post for comment")
    comment_by_reported = create_comment(
        user_id=reported_user.id, 
        post_id=comment_parent_post.id, 
        content="Public comment", 
        visibility=CommentVisibility.PUBLIC
    )
    
    ampersound_by_reported = create_ampersound(
        user_id=reported_user.id, 
        name='publicSound', 
        file_path='path/public.mp3', 
        privacy='public' # Ampersound uses string for privacy
    )
    db.session.commit()

    # Admin reports one of the posts
    report_data = {
        'content_type': 'post',
        'content_id': post1_by_reported.id,
        'reason': 'Admin report for restriction.'
    }
    response = client.post('/api/v1/reports', json=report_data)
    
    assert response.status_code == 201
    json_data = response.get_json()
    assert "Report submitted and user's content automatically restricted" in json_data['message']
    assert 'report_id' in json_data

    # Verify the report in the database
    report_in_db = Report.query.get(json_data['report_id'])
    assert report_in_db is not None
    assert report_in_db.reported_user_id == reported_user.id
    assert report_in_db.status == ReportStatus.RESOLVED_AUTO

    # Verify all content by reported_user is now restricted
    # Reload from DB to get updated state
    db.session.refresh(post1_by_reported)
    db.session.refresh(post2_by_reported)
    db.session.refresh(comment_by_reported)
    db.session.refresh(ampersound_by_reported)

    assert post1_by_reported.privacy == PostPrivacy.FRIENDS
    assert post2_by_reported.privacy == PostPrivacy.FRIENDS
    assert comment_by_reported.visibility == CommentVisibility.FRIENDS_ONLY
    assert ampersound_by_reported.privacy == 'friends' # String value for ampersound

def test_admin_report_on_comment_restricts_all_user_content(
    client, create_user, create_post, create_comment, create_ampersound, admin_user_auth_data
):
    """Test admin reporting a comment restricts all of reported user's content."""
    admin_headers = admin_user_auth_data['headers']
    reported_user = create_user(username='UserToRestrictComment', email='restrictcomment@example.com')
    
    post1 = create_post(user_id=reported_user.id, content="Post A", privacy=PostPrivacy.PUBLIC)
    # Parent post for the comment
    parent_post_owner = create_user(username='ParentOwnerComment', email='parentcomment@example.com')
    parent_post = create_post(user_id=parent_post_owner.id, content="Parent for reported comment")
    comment_to_report = create_comment(user_id=reported_user.id, post_id=parent_post.id, content="Offensive comment here", visibility=CommentVisibility.PUBLIC)
    amp1 = create_ampersound(user_id=reported_user.id, name='soundX', file_path='x.mp3', privacy='public')
    db.session.commit()

    report_data = {
        'content_type': 'comment',
        'content_id': comment_to_report.id,
        'reason': 'Admin report on comment.'
    }
    response = client.post('/api/v1/reports', json=report_data)
    assert response.status_code == 201
    json_data = response.get_json()
    assert "Report submitted and user's content automatically restricted" in json_data['message']
    report_in_db = Report.query.get(json_data['report_id'])
    assert report_in_db is not None
    assert report_in_db.reported_user_id == reported_user.id
    assert report_in_db.status == ReportStatus.RESOLVED_AUTO

    db.session.refresh(post1)
    db.session.refresh(comment_to_report)
    db.session.refresh(amp1)

    assert post1.privacy == PostPrivacy.FRIENDS
    assert comment_to_report.visibility == CommentVisibility.FRIENDS_ONLY
    assert amp1.privacy == 'friends'

def test_admin_report_on_ampersound_restricts_all_user_content(
    client, create_user, create_post, create_comment, create_ampersound, admin_user_auth_data
):
    """Test admin reporting an ampersound restricts all of reported user's content."""
    admin_headers = admin_user_auth_data['headers']
    reported_user = create_user(username='UserToRestrictAmp', email='restrictamp@example.com')

    post1 = create_post(user_id=reported_user.id, content="Post B", privacy=PostPrivacy.PUBLIC)
    parent_post_owner = create_user(username='ParentOwnerAmp', email='parentamp@example.com')
    parent_post = create_post(user_id=parent_post_owner.id, content="Parent for comment near ampersound report")
    comment1 = create_comment(user_id=reported_user.id, post_id=parent_post.id, content="A comment", visibility=CommentVisibility.PUBLIC)
    ampersound_to_report = create_ampersound(user_id=reported_user.id, name='soundY', file_path='y.mp3', privacy='public')
    db.session.commit()

    report_data = {
        'content_type': 'ampersound',
        'content_id': ampersound_to_report.id,
        'reason': 'Admin report on ampersound.'
    }
    response = client.post('/api/v1/reports', json=report_data)
    assert response.status_code == 201
    json_data = response.get_json()
    assert "Report submitted and user's content automatically restricted" in json_data['message']
    report_in_db = Report.query.get(json_data['report_id'])
    assert report_in_db is not None
    assert report_in_db.reported_user_id == reported_user.id
    assert report_in_db.status == ReportStatus.RESOLVED_AUTO

    db.session.refresh(post1)
    db.session.refresh(comment1)
    db.session.refresh(ampersound_to_report)

    assert post1.privacy == PostPrivacy.FRIENDS
    assert comment1.visibility == CommentVisibility.FRIENDS_ONLY
    assert ampersound_to_report.privacy == 'friends'

def test_admin_report_on_user_with_only_one_content_type(
    client, create_user, create_post, admin_user_auth_data
):
    """Test admin reporting when user only has one type of content (e.g., only posts)."""
    admin_headers = admin_user_auth_data['headers']
    reported_user = create_user(username='UserWithOnlyPosts', email='onlyposts@example.com')
    
    post_to_report = create_post(user_id=reported_user.id, content="My only post", privacy=PostPrivacy.PUBLIC)
    # This user has no comments or ampersounds
    db.session.commit()

    report_data = {
        'content_type': 'post',
        'content_id': post_to_report.id,
        'reason': 'Admin report; user has only posts.'
    }
    response = client.post('/api/v1/reports', json=report_data)
    assert response.status_code == 201 # Should succeed without error
    json_data = response.get_json()
    assert "Report submitted and user's content automatically restricted" in json_data['message']
    
    report_in_db = Report.query.filter_by(id=json_data['report_id']).first()
    assert report_in_db.status == ReportStatus.RESOLVED_AUTO
    
    db.session.refresh(post_to_report)
    assert post_to_report.privacy == PostPrivacy.FRIENDS
    # Implicitly, the test passes if no error occurs due to empty comment/ampersound lists.

def test_admin_report_on_already_restricted_content(
    client, create_user, create_post, admin_user_auth_data
):
    """Test admin reporting content that is already friends-only."""
    admin_headers = admin_user_auth_data['headers']
    reported_user = create_user(username='UserAlreadyRestricted', email='already@example.com')

    # Create a post that is already friends-only
    already_restricted_post = create_post(user_id=reported_user.id, content="Already friends post", privacy=PostPrivacy.FRIENDS)
    db.session.commit()

    report_data = {
        'content_type': 'post',
        'content_id': already_restricted_post.id,
        'reason': 'Admin reporting already restricted content.'
    }
    response = client.post('/api/v1/reports', json=report_data)
    assert response.status_code == 201
    json_data = response.get_json()
    assert "Report submitted and user's content automatically restricted" in json_data['message']

    report_in_db = Report.query.filter_by(id=json_data['report_id']).first()
    assert report_in_db.status == ReportStatus.RESOLVED_AUTO

    db.session.refresh(already_restricted_post)
    assert already_restricted_post.privacy == PostPrivacy.FRIENDS # Should remain friends

# Removed previous placeholders as these cover the admin scenarios more specifically

# Consider edge cases:
# - What if reported user has no posts/comments/ampersounds? (should not error)
# - Admin reporting content that is ALREADY friends-only (should remain friends-only, report still RESOLVED_AUTO) 