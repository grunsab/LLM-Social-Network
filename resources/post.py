from flask import request, jsonify, current_app
from flask_restful import Resource, reqparse, fields, marshal_with, marshal
from flask_login import current_user, login_required
from werkzeug.utils import secure_filename
from werkzeug.datastructures import FileStorage # Import FileStorage for reqparse
import uuid
import os
from sqlalchemy.orm import joinedload, undefer

from models import db, User, Post, PostCategoryScore, UserInterest, PostPrivacy, FriendRequest, FriendRequestStatus, Comment
# Import the formatter function
from utils import format_text_with_ampersounds 

# We might need access to the S3 client and GemmaClassification instance from app.py
# This might require passing app context or using current_app

# Parser for post creation
post_parser = reqparse.RequestParser()
post_parser.add_argument('content', type=str, required=False, help='Post content (text)', location='form')
post_parser.add_argument('image', type=FileStorage, required=False, help='Image file for the post', location='files')
post_parser.add_argument('privacy', type=str, default='FRIENDS', choices=([p.name for p in PostPrivacy]), help='Post privacy setting (PUBLIC, FRIENDS)', location='form')

list_posts_parser = reqparse.RequestParser() # For GET list
list_posts_parser.add_argument('page', type=int, default=1, help='Page number for pagination', location='args')
list_posts_parser.add_argument('per_page', type=int, default=20, help='Number of posts per page', location='args')

# --- Field definitions for Marshaling --- 
# Define how nested objects should be serialized
author_fields = {
    'id': fields.Integer,
    'username': fields.String,
    'profile_picture': fields.String # Add profile pic if needed
}

# Formatted content field for Ampersounds
class FormattedContent(fields.Raw):
    def format(self, value):
        # value can be a Post object or an error dictionary
        if not isinstance(value, Post) or not hasattr(value, 'content') or not hasattr(value, 'author') or not value.author:
            # If it's not a Post object with content and author, or if author is None,
            # return it as is (if dict) or its content attribute if it has one but no author.
            if isinstance(value, dict):
                return value #likely an error message dict
            elif hasattr(value, 'content'):
                 return value.content # Post object might lack author in some edge cases, return raw content
            return str(value) # Fallback for other types
            
        # It is a Post object with content and author
        return format_text_with_ampersounds(value.content, value.author.username)

post_fields = {
    'id': fields.Integer,
    'content': FormattedContent(attribute=lambda x: x), # Pass the whole post object to our custom field
    'image_url': fields.String,
    'timestamp': fields.DateTime(dt_format='iso8601'),
    'privacy': fields.String(attribute='privacy.name'), # Get enum name
    'author': fields.Nested(author_fields), # Nested author data
    'classification_scores': fields.Raw(attribute='classification_scores'), # Keep as JSON object
    # Add comments count or other fields later if needed
    'comments_count': fields.Integer, # Use the column_property directly
    'likes_count': fields.Integer, # Add likes_count
    'is_liked': fields.Boolean(default=False) # Add is_liked, default to False
}

post_list_fields = {
    'posts': fields.List(fields.Nested(post_fields)),
    'page': fields.Integer,
    'per_page': fields.Integer,
    'total': fields.Integer # Total number of posts matching query (before pagination)
}

class PostListResource(Resource):
    @login_required
    def post(self):
        args = post_parser.parse_args()
        content = args['content']
        image_file = args['image']
        privacy_str = args['privacy']

        # Access app context items
        s3_client = current_app.config.get('S3_CLIENT') # Assume s3_client is stored in app config or context
        gemma_classification = current_app.config.get('GEMMA_CLASSIFIER') # Same assumption
        s3_bucket = current_app.config.get('S3_BUCKET')
        domain_name_images = current_app.config.get('DOMAIN_NAME_IMAGES')

        if not content and not image_file:
            return {'message': 'Post cannot be empty. Provide text or an image.'}, 400

        image_url = None
        image_classification_result = None

        # --- Handle Image Upload --- (Adapted from app.py/create_post)
        if image_file and s3_client and s3_bucket:
            if image_file.filename == '':
                # No file selected, but 'image' key might be present
                pass # Allow posts with just text
            else:
                # Check file size - limit to 10MB
                image_file.seek(0, os.SEEK_END)
                file_size = image_file.tell()
                image_file.seek(0)
                if file_size > 3 * 1024 * 1024:
                    return {'message': 'Image file too large (max 3MB)'}, 413 # Payload Too Large

                file_extension = os.path.splitext(image_file.filename)[1]
                unique_filename = f"images/{uuid.uuid4()}{file_extension}"

                try:
                    image_data = image_file.read()
                    image_file.seek(0)

                    s3_client.upload_fileobj(
                        image_file,
                        s3_bucket,
                        unique_filename,
                    )
                    image_url = f"{domain_name_images}/{unique_filename}"
                    print(f"INFO: Image uploaded to {image_url}")

                    # Classify the image (ensure gemma_classification is available)
                    if gemma_classification:
                        image_classification_result = gemma_classification.classify_image(image_data)
                        if image_classification_result:
                            print(f"INFO: Image classified: {image_classification_result}")
                        else:
                            print("WARN: Image classification failed or returned None.")
                    else:
                        print("WARN: GemmaClassification not available for image.")

                except Exception as e:
                    print(f"ERROR: Failed to upload image to S3: {e}")
                    return {'message': f'Image upload failed: {e}'}, 500

        elif image_file and not s3_client:
            print('WARN: Image provided, but S3 is not configured. Image was not saved.')
            # Decide if this should be an error or just a warning message in response
            # return {'message': 'S3 not configured, image not saved'}, 400

        # --- Handle Text Content and Classification ---
        text_classification_result = None
        if content and gemma_classification:
            text_classification_result = gemma_classification.classify_text(content)
            if text_classification_result is None:
                print('WARN: Text classification failed or returned None.')
                 # Decide if this should be an error
                 # return {'message': 'Text classification failed'}, 500
            else:
                print(f"INFO: Text classified: {text_classification_result}")
        elif content and not gemma_classification:
            print("WARN: GemmaClassification not available for text.")

        # --- Create and Save Post ---
        try:
            privacy_enum = PostPrivacy[privacy_str]
            new_post = Post(
                content=content if content else "", # Ensure content is not None
                user_id=current_user.id,
                image_url=image_url,
                classification_scores={}, # To be populated
                privacy=privacy_enum
            )
            db.session.add(new_post)
            db.session.flush() # Need post ID for scores

            combined_classifications = {}
            # Process Text Classification
            if text_classification_result:
                for category, score in text_classification_result.items():
                    combined_classifications[category] = score
                    # Update UserInterest
                    interest = UserInterest.query.filter_by(user_id=current_user.id, category=category).first()
                    if interest: interest.score += score
                    else: db.session.add(UserInterest(user_id=current_user.id, category=category, score=score))

            # Process Image Classification
            if image_classification_result:
                for category, score in image_classification_result.items():
                    # Average score if category exists from text
                    combined_classifications[category] = (combined_classifications.get(category, 0) + score) / (2.0 if category in combined_classifications else 1.0)
                    # Update UserInterest
                    interest = UserInterest.query.filter_by(user_id=current_user.id, category=category).first()
                    if interest: interest.score += score # Consider averaging or different logic here too
                    else: db.session.add(UserInterest(user_id=current_user.id, category=category, score=score))

            # Save Combined Classifications (JSON and relational)
            new_post.classification_scores = combined_classifications
            for category, score in combined_classifications.items():
                db.session.add(PostCategoryScore(post_id=new_post.id, category=category, score=score))

            db.session.commit()

            # Ensure the object is refreshed from the database session to load all attributes
            # and relationships correctly before marshalling, especially after a commit.
            db.session.refresh(new_post)
            # Optionally, to be absolutely sure relationships like author are loaded if not already:
            # new_post = Post.query.options(joinedload(Post.author)).get(new_post.id)
            # However, refresh should typically handle making attributes available.
            
            # Use marshal to format the new_post object with post_fields
            # This will apply the FormattedContent field for ampersounds.
            formatted_post_data = marshal(new_post, post_fields)

            return {
                'message': 'Post created successfully',
                'post': formatted_post_data
             }, 201

        except Exception as e:
            db.session.rollback()
            print(f"ERROR: Failed to save post to database: {e}")
            return {'message': f'Error creating post: {e}'}, 500

    @login_required
    @marshal_with(post_list_fields) # Use marshal_with to automatically format output
    def get(self):
        args = list_posts_parser.parse_args()
        page = args['page']
        per_page = args['per_page']
        
        blocked_categories = current_app.config.get('BLOCKED_CATEGORIES', set())

        # --- Query Building (adapted from app.py/index) ---
        # Base query - Eager load author and scores needed for filtering/display
        base_query = Post.query.options(
            joinedload(Post.author),
            joinedload(Post.category_scores),
            undefer(Post.comments_count) # Explicitly load comments_count
        )

        # 1. Public Posts
        public_posts_q = base_query.filter(Post.privacy == PostPrivacy.PUBLIC)

        # 2. Friends' Posts (Friends Only)
        # Find IDs of friends
        friend_ids = current_user.get_friend_ids() # Assumes User model has get_friend_ids()
        friends_posts_q = base_query.filter(
            Post.user_id.in_(friend_ids),
            Post.privacy == PostPrivacy.FRIENDS
        )

        # 3. Own Posts
        own_posts_q = base_query.filter(Post.user_id == current_user.id)

        # Combine queries using union (might need adjustment depending on exact SQLalchemy version/behavior)
        # A simpler approach for filtering might be to fetch all potentially visible posts
        # and filter in Python, especially if the total number isn't massive.
        # Let's try filtering directly in the query:
        
        combined_filter = (
            (Post.privacy == PostPrivacy.PUBLIC) |
            (Post.user_id == current_user.id) |
            (
                (Post.privacy == PostPrivacy.FRIENDS) &
                Post.user_id.in_(friend_ids)
            )
        )
        
        # Initial query with visibility filter
        visible_posts_query = base_query.filter(combined_filter)
        
        # Apply category blocking - This is tricky with SQL efficiently.
        # It's often easier to filter after fetching or use a subquery/CTE if performance demands it.
        # Simple Python filter after query:
        paginated_query = visible_posts_query.order_by(Post.timestamp.desc()).paginate(
            page=page, per_page=per_page, error_out=False
        )
        
        all_posts_in_page = paginated_query.items
        total_posts_count = paginated_query.total # Get total count from pagination object
        
        # Filter out blocked categories in Python
        filtered_posts = []
        for post in all_posts_in_page:
            post_categories = {score.category for score in post.category_scores}
            if not post_categories.intersection(blocked_categories):
                filtered_posts.append(post)

        # Marshal the final list of posts
        # The marshal_with decorator handles the final structure
        return {
            'posts': filtered_posts,
            'page': page,
            'per_page': per_page,
            'total': total_posts_count # Note: This total is *before* category filtering.
                                        # Accurate total requires counting after filtering, more complex query.
        }

class PostResource(Resource):
    @marshal_with(post_fields)
    def get(self, post_id):
        post = Post.query.options(
            joinedload(Post.author), 
            undefer(Post.comments_count) # Make sure comments_count is loaded
        ).get(post_id) # Use .get() and handle not found manually

        if not post:
            return {'message': 'Post not found'}, 404

        can_view = False
        if post.privacy == PostPrivacy.PUBLIC:
            can_view = True
        elif current_user.is_authenticated: # Only check friends/own if logged in
            if post.user_id == current_user.id:
                can_view = True
            elif post.privacy == PostPrivacy.FRIENDS:
                # Check if the post author is a friend of the current_user
                # Ensure post.author is not None before accessing its attributes or relationships
                if post.author and (current_user.is_friend(post.author) or post.author == current_user) : # Assuming is_friend method
                    can_view = True
        
        if not can_view:
            # Differentiate message for logged-in vs anonymous
            if current_user.is_authenticated:
                return {'message': 'You do not have permission to view this post.'}, 403
            else: # Not logged in and post is not public
                return {'message': 'This post requires login to view or is not public.'}, 401

        # Manually set is_liked for the current user if logged in
        if current_user.is_authenticated:
            # Assuming Post model has a method is_liked_by_user(user_id)
            # or you query PostLike table directly
            post.is_liked = post.is_liked_by_user(current_user.id) 
        else:
            post.is_liked = False # Default for anonymous users

        return post

    @login_required
    def delete(self, post_id):
        # Logic for deleting a post (migrated from delete_post route)
        post_to_delete = Post.query.get_or_404(post_id)
        if post_to_delete.user_id != current_user.id:
            # Prevent users from deleting others' posts
            return {'message': 'You do not have permission to delete this post.'}, 403 # Forbidden

        try:
            # Delete associated category score entries first
            PostCategoryScore.query.filter_by(post_id=post_to_delete.id).delete(synchronize_session='fetch') # Changed synchronize_session strategy
            
            # Delete associated comments (assuming Comment model has post_id)
            Comment.query.filter_by(post_id=post_to_delete.id).delete(synchronize_session='fetch')

            db.session.delete(post_to_delete)
            db.session.commit()
            return {'message': 'Post deleted successfully.'}, 200 # OK or 204 No Content
        except Exception as e:
            db.session.rollback()
            print(f"Error deleting post {post_id}: {e}") # Log the error
            return {'message': f'Error deleting post: {e}'}, 500

    @login_required
    @marshal_with(post_fields)
    def put(self, post_id):
        # Logic for updating a post (optional)
        # Check ownership, parse updates, save changes
        # Example: Update content and privacy
        update_parser = reqparse.RequestParser()
        update_parser.add_argument('content', type=str, required=False, location='json')
        update_parser.add_argument('privacy', type=str, choices=([p.name for p in PostPrivacy]), required=False, location='json')
        args = update_parser.parse_args()

        post_to_update = Post.query.get_or_404(post_id)
        if post_to_update.user_id != current_user.id:
            return {'message': 'You do not have permission to update this post.'}, 403

        updated = False
        if args['content'] is not None:
            post_to_update.content = args['content']
            # Note: Re-classification might be needed if content changes significantly
            updated = True
        
        if args['privacy'] is not None:
            try:
                post_to_update.privacy = PostPrivacy[args['privacy']]
                updated = True
            except KeyError:
                 return {'message': f'Invalid privacy value: {args["privacy"]}'}, 400

        if not updated:
            return {'message': 'No update data provided'}, 400
        
        try:
            db.session.commit()
             # Return updated post data (need serialization)
            db.session.refresh(post_to_update) # Refresh to get latest state after commit if needed
            return post_to_update # Return the updated post object
        except Exception as e:
            db.session.rollback()
            print(f"Error updating post {post_id}: {e}")
            return {'message': f'Error updating post: {e}'}, 500

# Resource for liking/unliking a post
class PostLikeResource(Resource):
    @login_required
    def post(self, post_id):
        post = Post.query.get_or_404(post_id)
        
        # Check if user can view the post before liking (optional but good practice)
        # This reuses the visibility logic from PostResource.get, can be refactored
        can_view = False
        if post.privacy == PostPrivacy.PUBLIC or post.user_id == current_user.id:
            can_view = True
        elif post.privacy == PostPrivacy.FRIENDS:
            if current_user.is_friend(post.author):
                can_view = True
        
        if not can_view:
            return {'message': 'You do not have permission to like this post as you cannot view it.'}, 403

        from models import PostLike # Import here to avoid circular dependency issues

        like = PostLike.query.filter_by(user_id=current_user.id, post_id=post.id).first()

        if like:
            # User has already liked the post, so unlike it
            db.session.delete(like)
            db.session.commit()
            # Refresh likes_count from the DB property
            db.session.refresh(post)
            return {'message': 'Post unliked', 'likes_count': post.likes_count, 'is_liked': False}, 200
        else:
            # User has not liked the post, so like it
            new_like = PostLike(user_id=current_user.id, post_id=post.id)
            db.session.add(new_like)
            db.session.commit()
            # Refresh likes_count from the DB property
            db.session.refresh(post)
            return {'message': 'Post liked', 'likes_count': post.likes_count, 'is_liked': True}, 201