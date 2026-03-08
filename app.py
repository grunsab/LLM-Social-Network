import os
import json
import uuid
import sys
import base64
from flask import Flask, request, jsonify, send_from_directory, render_template, redirect, url_for
from flask_login import login_required, current_user
from flask_restful import Api
from werkzeug.security import generate_password_hash, check_password_hash
from sqlalchemy import or_, func, case, desc, union_all, and_
from sqlalchemy.orm import joinedload, undefer
from dotenv import load_dotenv
import boto3
from openai import OpenAI
import mimetypes
from werkzeug.utils import secure_filename
import re # Import regular expression module
from flask_cors import CORS # Import CORS
from flask_limiter import Limiter # Import Limiter
from flask_limiter.util import get_remote_address # Import default key function

# Import extensions and models AFTER defining configurations
from extensions import db, login_manager, migrate
# Import models here if they don't depend on the app instance directly at import time
# If models.py imports 'app', this needs further adjustment.
from models import User, Post, Comment, FriendRequest, InviteCode, UserInterest, PostPrivacy, Ampersound, UserType

# Import Resources AFTER defining configurations and extensions
from resources.auth import UserRegistration, UserLogin, UserLogout
from resources.post import PostListResource, PostResource, PostLikeResource
from resources.comment import CommentListResource, CommentResource
from resources.profile import ProfileResource, MyProfileResource, profile_data_fields
from resources.friendship import FriendRequestListResource, FriendRequestResource, FriendshipResource
from resources.feed import FeedResource
from resources.category import CategoryResource
from resources.invite import InviteResource
from resources.report import ReportResource, ReportListResource, AdminReportListResource, AdminReportActionResource
from resources.notification import NotificationListResource, NotificationResource, UnreadCountResource
from resources.image_generation import ImageGenerationResource # Added import
from resources.image_remix import ImageRemixResource # Added import for image remixing
from resources.ampersound import AmpersoundListResource, AmpersoundResource, MyAmpersoundsResource, AmpersoundSearchResource # Added Ampersound resources
from resources.ampersound_youtube import AmpersoundFromYoutubeResource # New resource for YouTube to Ampersound
from resources.admin import AdminAmpersoundApprovalList, AdminAmpersoundApprovalAction # Added Admin Ampersound resources
from resources.chat import (
    ChatBootstrapResource,
    ChatDMResource,
    ChatFriendsResource,
    ChatGroupMemberResource,
    ChatGroupResource,
)
from utils import generate_s3_file_url # Import the utility function

# Import for password hashing if not already globally available in this scope
from werkzeug.security import generate_password_hash

# Load environment variables early
load_dotenv()

# Define base configuration class
class Config:
    SECRET_KEY = os.environ.get('SECRET_KEY')
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    DEBUG = False
    TESTING = False
    # Default to SQLite if DATABASE_URL is not set
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URL', 'sqlite:///social_network.db')
    if SQLALCHEMY_DATABASE_URI.startswith("postgres://"):
        SQLALCHEMY_DATABASE_URI = SQLALCHEMY_DATABASE_URI.replace("postgres://", "postgresql://", 1)

    # S3/R2 Config (Load from environment)
    S3_BUCKET = os.environ.get("S3_BUCKET", "socialnetworkgemma")
    S3_KEY = os.environ.get("S3_KEY")
    S3_SECRET = os.environ.get("S3_SECRET_ACCESS_KEY")
    S3_REGION = os.environ.get("S3_REGION", "auto")
    S3_ENDPOINT_URL = os.environ.get("S3_ENDPOINT_URL")
    DOMAIN_NAME_IMAGES = os.environ.get("DOMAIN_NAME_IMAGES")

    # Other Config
    MODEL_NAME = os.environ.get("MODEL_NAME", "google/gemma-3-4b-it")
    FRONTEND_URL = os.environ.get('FRONTEND_URL', '')
    OPENAI_API_KEY = os.environ.get('OPENAI_API_KEY')
    DEEPINFRA_API_BASE = "https://api.deepinfra.com/v1/openai" # Centralize this
    DEEPINFRA_API_KEY = os.environ.get('DEEPINFRA_API_KEY') # Added DeepInfra API Key
    RUNWARE_API_KEY = os.environ.get('RUNWARE_API_KEY') # Added Runware API Key for image remixing

    # SpacetimeDB chat configuration
    SPACETIMEDB_HTTP_URL = os.environ.get('SPACETIMEDB_HTTP_URL', 'https://maincloud.spacetimedb.com')
    SPACETIMEDB_WS_URL = os.environ.get('SPACETIMEDB_WS_URL', 'wss://maincloud.spacetimedb.com')
    SPACETIMEDB_DB_NAME = os.environ.get('SPACETIMEDB_DB_NAME')
    SPACETIMEDB_DB_ID = os.environ.get('SPACETIMEDB_DB_ID')
    SPACETIMEDB_SERVICE_TOKEN = os.environ.get('SPACETIMEDB_SERVICE_TOKEN')
    SPACETIMEDB_TOKEN_ENCRYPTION_KEY = os.environ.get('SPACETIMEDB_TOKEN_ENCRYPTION_KEY')
    SPACETIMEDB_HTTP_TIMEOUT_SECONDS = int(os.environ.get('SPACETIMEDB_HTTP_TIMEOUT_SECONDS', '15'))

    @staticmethod
    def init_app(app):
        # Placeholder for config-specific initialization if needed later
        
        # Secure SECRET_KEY handling
        if not app.config.get('SECRET_KEY') and not app.config.get('DEBUG') and not app.config.get('TESTING'):
             raise ValueError("ERROR: SECRET_KEY is not set in environment for production/non-debug mode.")
        
        # You could add a check for a specific weak default key here too if needed,
        # but requiring it to be set at all outside of debug/test is a good start.
        
        pass

# Define development configuration
class DevelopmentConfig(Config):
    DEBUG = True
    # Example: Use a specific dev database if needed
    # SQLALCHEMY_DATABASE_URI = os.environ.get('DEV_DATABASE_URL') or 'sqlite:///social_network_dev.db'

# Define testing configuration
class TestingConfig(Config):
    TESTING = True
    SQLALCHEMY_DATABASE_URI = os.environ.get('TEST_DATABASE_URL') or 'sqlite:///:memory:' # Use in-memory SQLite for tests
    WTF_CSRF_ENABLED = False # Disable CSRF forms protection during tests
    SECRET_KEY = 'test-secret-key' # Use a fixed key for tests
    # Disable external services for testing if possible
    S3_BUCKET = None
    OPENAI_API_KEY = None

# Define production configuration
class ProductionConfig(Config):
    # Production specific settings (e.g., force HTTPS, different logging)
    SQLALCHEMY_DATABASE_URI = os.environ.get('DATABASE_URL') # Get from env

    @staticmethod
    def init_app(app):
        # Call parent init_app if necessary
        # Config.init_app(app)

        # Check for DATABASE_URL when this config is initialized for an app
        database_url = app.config.get('SQLALCHEMY_DATABASE_URI')
        if not database_url:
            raise ValueError("No DATABASE_URL set for production environment")
        
        # Ensure postgres:// is replaced with postgresql://
        if database_url.startswith("postgres://"):
            app.config['SQLALCHEMY_DATABASE_URI'] = database_url.replace("postgres://", "postgresql://", 1)
            print("INFO: Updated DATABASE_URL prefix for SQLAlchemy in ProductionConfig.")

# Configuration dictionary
config = {
    'development': DevelopmentConfig,
    'testing': TestingConfig,
    'production': ProductionConfig,
    'default': DevelopmentConfig # Default to development
}


# Load blocked categories (can remain outside create_app)
BLOCKED_CATEGORIES = set()
blocked_categories_path = os.path.join(os.path.dirname(__file__), 'blocked_categories.json')
try:
    with open(blocked_categories_path, 'r') as f:
        BLOCKED_CATEGORIES = set(json.load(f))
    print(f"INFO: Loaded {len(BLOCKED_CATEGORIES)} blocked categories from file.")
except FileNotFoundError:
    print(f"WARN: blocked_categories.json not found at {blocked_categories_path}. No categories will be blocked.")
except json.JSONDecodeError:
    print(f"ERROR: Could not decode JSON from {blocked_categories_path}. No categories will be blocked.")


# --- Gemma Classification Class ---
# Moved definition here, depends on loaded categories but not the app instance yet
class GemmaClassification:
    def __init__(self, app_config):
        # Load categories from JSON file or use defaults
        categories_path = os.path.join(os.path.dirname(__file__), 'categories.json')
        try:
            with open(categories_path, 'r') as f:
                self.categories = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError) as e:
            print(f"WARN: Could not load categories from {categories_path}: {e}. Using defaults.")
            # Define some sensible defaults if file is missing/invalid
            self.categories = ["Technology", "Travel", "Food", "Art", "Sports", "News", "Lifestyle", "Politics", "Science", "Business", "Entertainment", "Health", "Education", "Environment"]

        # Get config values needed during initialization
        self.model = app_config.get('MODEL_NAME')
        self.openai_api_key = app_config.get('OPENAI_API_KEY')
        self.deepinfra_api_base = app_config.get('DEEPINFRA_API_BASE')

        # Initialize OpenAI client only if API key is available
        if self.openai_api_key and self.deepinfra_api_base:
             self.openai_client = OpenAI(
                api_key=self.openai_api_key,
                base_url=self.deepinfra_api_base,
             )
             print(f"INFO: OpenAI client initialized for model {self.model}")
        else:
             self.openai_client = None
             print("WARN: OpenAI client not initialized (missing API key or base URL).")

        self.max_tokens = 1024
        self.response_format = {"type": "json_object"}
        self.prompt = f"""Classify the subject matter of the following information into relevant categories from the list below.
            Provide a relevance score between 0.0 and 1.0 for each category you assign (higher means more relevant).
            Return the results as a JSON object where keys are category names and values are their scores.
            Only include categories with a score > 0.1.
            If no category seems relevant or confidence is low, return an empty JSON object {{}}.
            Categories: {", ".join(self.categories)}
            JSON Output:"""

    def default_classify_function(self, messages):
        if not self.openai_client:
            print("ERROR: OpenAI client not configured for classification.")
            return {}
        try:
            chat_completion = self.openai_client.chat.completions.create(
                model=self.model,
                messages=messages,
                response_format=self.response_format,
                max_tokens=self.max_tokens
            )
            
            self.response_content = chat_completion.choices[0].message.content.strip()
            print(f"DEBUG: Gemma response: {self.response_content}")

            # Handle potentially malformed JSON
            try:
                self.category_scores = json.loads(self.response_content)
            except json.JSONDecodeError as je:
                print(f"ERROR: Failed to parse JSON response: {je}")
                print(f"Raw response: {self.response_content}")
                return {}

            # Basic validation
            if not isinstance(self.category_scores, dict):
                print(f"ERROR: Classification result is not a dictionary: {type(self.category_scores)}")
                return {}
            
            validated_scores = {}
            for category, score in self.category_scores.items():
                if category in self.categories and isinstance(score, (int, float)) and 0.0 <= score <= 1.0:
                    validated_scores[category] = float(score)
                else:
                    print(f"WARN: Invalid category '{category}' or score '{score}' received, skipping.")

            return validated_scores or {}  # Return empty dict if no valid categories found
            
        except Exception as e:
            print(f"ERROR: An error occurred during classification: {e}")
            return {}  # Return empty dict on error

    def classify_text(self, post_content):
        """
        Classifies post content into multiple categories with scores using Gemma.
        Returns a dictionary of {category: score} or empty dict if classification fails.
        """
        if not post_content or not post_content.strip():
            print("INFO: Empty post content provided, skipping classification.")
            return {}
            
        print(f"INFO: Classifying text post: {post_content[:50]}...")
        
        # Clear and specific structured messages
        messages = [
            {"role": "system", "content": "You are a classifier that categorizes content and returns results only as a valid JSON object."},
            {"role": "user", "content": f"{self.prompt}\n\nContent to classify: {post_content}"}
        ]

        return self.default_classify_function(messages)

                
    def classify_image(self, image_data):
        """
        Classifies image data into categories with scores using the configured Gemma multimodal endpoint.
        Input: image_data (bytes)
        Returns: Dictionary of {category: score} or empty dict if classification fails.
        """
        if not image_data:
            print("ERROR: No image data provided for classification.")
            return {}
            
        print(f"INFO: Classifying image of size {len(image_data)} bytes...")
        
        try:
            # Encode the image data to base64
            base64_image = base64.b64encode(image_data).decode('utf-8')
            
            # Format messages for multimodal API (DeepInfra's expected format)
            messages = [
                {"role": "system", "content": "You are a classifier that analyzes images and returns results only as a valid JSON object."},
                {"role": "user", "content": [
                    {"type": "text", "text": self.prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{base64_image}"}}
                ]}
            ]
            
            return self.default_classify_function(messages)
            
        except Exception as e:
            print(f"ERROR: Image classification failed: {e}")
            return {}


# --- Application Factory ---
def create_app(config_name='default', overrides=None): # Add overrides parameter
    
    try:
        app = Flask(__name__, static_folder='frontend/dist', static_url_path='/app_assets') # Corrected static folder path

        # Load configuration from the selected class
        app.config.from_object(config[config_name])
        if overrides: # Apply overrides here
            app.config.from_mapping(overrides)

        config[config_name].init_app(app) # Call static init_app if defined

        # Initialize CORS
        # Adjust origins and supports_credentials as needed for your setup.
        # FRONTEND_URL should be in your .env file, e.g., FRONTEND_URL=http://localhost:5173
        frontend_url = app.config.get('FRONTEND_URL', 'http://localhost:5173') # Default if not set
        CORS(app, supports_credentials=True, origins=[frontend_url])

        print(f"INFO: App created with config: {config_name}")
        print(f"INFO: Database URI: {app.config['SQLALCHEMY_DATABASE_URI']}")

        # Initialize extensions with the app instance
        db.init_app(app)
        login_manager.init_app(app)
        migrate.init_app(app, db)

        # Initialize Flask-Limiter
        limiter = Limiter(
            get_remote_address, # Use the client's IP address as the key
            app=app,
            default_limits=["20000 per day", "5000 per hour"], # Default limits for all routes (optional)
            storage_uri="memory://", # Use in-memory storage (consider Redis/Memcached for production)
            # strategy="fixed-window" # Optional: Define strategy (fixed-window, moving-window)
        )
        app.config['RATELIMIT_HEADERS_ENABLED'] = True # Add rate limit headers to responses
        app.config['limiter'] = limiter # Store limiter instance in app config for access elsewhere

        # Initialize Flask-Restful AFTER app is created
        api = Api(app)

        # Configure Flask-Login
        login_manager.init_app(app)

        @login_manager.unauthorized_handler
        def unauthorized():
            # For an API-only application, always return 401 when unauthorized
            response = jsonify(message="Authentication required.")
            response.status_code = 401
            return response

        @login_manager.user_loader
        def load_user(user_id):
            return db.session.get(User, int(user_id))

        # Initialize S3 client if config is present
        s3_client = None
        if app.config['S3_BUCKET'] and app.config['S3_KEY'] and app.config['S3_SECRET']:
            s3_client = boto3.client('s3',
                endpoint_url=app.config['S3_ENDPOINT_URL'],
                aws_access_key_id=app.config['S3_KEY'],
                aws_secret_access_key=app.config['S3_SECRET'],
                region_name=app.config['S3_REGION'],
            )
            app.config['S3_CLIENT'] = s3_client
            print(f"INFO: S3 Client initialized for bucket {app.config['S3_BUCKET']} in region {app.config['S3_REGION']} (Config: {config_name})")
        else:
            app.config['S3_CLIENT'] = None
            print(f"WARN: S3 credentials not found or disabled for config '{config_name}'. Image upload may be limited.")


        # Initialize GemmaClassification and store in app.config
        # It now takes the already populated app.config
        gemma_classifier = GemmaClassification(app.config)
        app.config['GEMMA_CLASSIFIER'] = gemma_classifier


        # Add API Resources using the 'api' instance initialized above
        api.add_resource(UserRegistration, '/api/v1/register')
        api.add_resource(UserLogin, '/api/v1/login')
        api.add_resource(UserLogout, '/api/v1/logout')
        api.add_resource(PostListResource, '/api/v1/posts')
        api.add_resource(PostResource, '/api/v1/posts/<int:post_id>')
        api.add_resource(PostLikeResource, '/api/v1/posts/<int:post_id>/like') # New endpoint for liking posts
        api.add_resource(CommentListResource, '/api/v1/posts/<int:post_id>/comments')
        api.add_resource(CommentResource, '/api/v1/comments/<int:comment_id>')
        api.add_resource(ProfileResource, '/api/v1/profiles/<string:username>')
        api.add_resource(FriendRequestListResource, '/api/v1/friend-requests')
        api.add_resource(FriendRequestResource, '/api/v1/friend-requests/<int:request_id>')
        api.add_resource(FriendshipResource, '/api/v1/friendships/<int:user_id>')
        api.add_resource(FeedResource, '/api/v1/feed')
        api.add_resource(CategoryResource, '/api/v1/categories/<string:category_name>/posts')
        api.add_resource(InviteResource, '/api/v1/invites', '/api/v1/invites/<string:code>')
        api.add_resource(ReportResource, '/api/v1/reports')
        api.add_resource(NotificationListResource, '/api/v1/notifications')
        api.add_resource(NotificationResource, '/api/v1/notifications/<int:notif_id>')
        api.add_resource(UnreadCountResource, '/api/v1/notifications/unread_count')
        api.add_resource(ImageGenerationResource, '/api/v1/generate_image') # Added route for image generation
        api.add_resource(ImageRemixResource, '/api/v1/remix_image') # Added route for image remixing
        api.add_resource(AmpersoundListResource, '/api/v1/ampersounds')
        api.add_resource(AmpersoundFromYoutubeResource, '/api/v1/ampersounds/from_youtube') # New route for YouTube to Ampersound
        api.add_resource(AmpersoundResource, '/api/v1/ampersounds/<int:sound_id>', '/api/v1/ampersounds/<string:username>/<string:sound_name>')
        api.add_resource(MyAmpersoundsResource, '/api/v1/ampersounds/my')
        api.add_resource(AmpersoundSearchResource, '/api/v1/ampersounds/search')

        # Chat endpoints (SpacetimeDB-backed)
        api.add_resource(ChatBootstrapResource, '/api/v1/chat/bootstrap')
        api.add_resource(ChatFriendsResource, '/api/v1/chat/friends')
        api.add_resource(ChatDMResource, '/api/v1/chat/dm')
        api.add_resource(ChatGroupResource, '/api/v1/chat/groups')
        api.add_resource(ChatGroupMemberResource, '/api/v1/chat/groups/<string:conversation_id>/members')

        # Add Admin Ampersound Approval Resources
        api.add_resource(AdminAmpersoundApprovalList, '/api/v1/admin/ampersounds/pending')
        api.add_resource(AdminAmpersoundApprovalAction, '/api/v1/admin/ampersounds/<int:ampersound_id>/action')


        # --- Manually add routes for MyProfileResource --- 
        # Instantiate the resource once (though it's stateless here)
        my_profile_view = MyProfileResource() 

        @app.route('/api/v1/profiles/me', methods=['GET'])
        @login_required
        def get_my_profile():
            # Manually call the resource's get method
            # Note: marshal_with won't apply automatically, but resource method returns dict.
            # Return data with default 200 status.
            response_data = my_profile_view.get()
            return jsonify(response_data), 200

        @app.route('/api/v1/profiles/me', methods=['PATCH'])
        @login_required
        def patch_my_profile():
            # Manually call the resource's patch method
            # Note: marshal_with won't apply automatically, resource method returns dict.
            # Return data with default 200 status.
            response_data = my_profile_view.patch()
            return jsonify(response_data), 200

        # --- Method Override (can stay as is) ---
        @app.before_request
        def method_override():
            if request.form and '_method' in request.form:
                method = request.form['_method'].upper()
                if method in ['PUT', 'DELETE', 'PATCH']:
                    request.environ['REQUEST_METHOD'] = method

        # --- Routes for serving frontend ---
        @app.route('/')
        @app.route('/<path:path>')
        def serve_react_app(path=None): # Optional path parameter
            # Ensure os is available (it's imported at the top of app.py)
            # Ensure send_from_directory is available (imported from flask at the top)
            
            # app.static_folder is 'frontend/dist'
            # app.root_path is the absolute path to the directory where app.py is.
            static_dir_abs = os.path.join(app.root_path, app.static_folder)

            if path:
                # Check if the requested path corresponds to an existing file
                # in the static directory (e.g., /assets/main.js -> PROJECT_ROOT/frontend/dist/assets/main.js)
                requested_file_abs = os.path.join(static_dir_abs, path)
                # Ensure it's a file and not a directory to prevent issues
                if os.path.exists(requested_file_abs) and os.path.isfile(requested_file_abs):
                    # send_from_directory uses app.static_folder (which is 'frontend/dist')
                    # and correctly resolves it relative to app.root_path.
                    return send_from_directory(app.static_folder, path)
            
            # If 'path' is None (root URL /) or if 'path' does not point to an existing file,
            # serve the index.html for client-side routing.
            index_html_abs = os.path.join(static_dir_abs, 'index.html')
            if os.path.exists(index_html_abs): # index.html must be a file
                return send_from_directory(app.static_folder, 'index.html')
            else:
                # Fallback if index.html itself is missing, with more detailed logging
                app.logger.error(f"CRITICAL: index.html not found at {index_html_abs} (app.static_folder='{app.static_folder}', app.root_path='{app.root_path}')")
                return jsonify({"error": "React app not found. Build the frontend first.", "detail": f"Looked for index.html at {index_html_abs}"}), 404

        @app.route('/privacy')
        def privacy_policy():
            return render_template('privacy.html')

        @app.route('/api/v1/profiles/upload_picture', methods=['POST'])
        @login_required
        def upload_profile_picture():
            MAX_CONTENT_LENGTH = 5 * 1024 * 1024 # 5 MB limit
            if request.content_length is not None and request.content_length > MAX_CONTENT_LENGTH:
                 return jsonify({"message": f"File size exceeds the limit of {MAX_CONTENT_LENGTH / 1024 / 1024}MB."}), 413 # Payload Too Large

            if 'file' not in request.files:
                return jsonify({"message": "No file part"}), 400
            
            file = request.files['file']
            if file.filename == '':
                return jsonify({"message": "No selected file"}), 400

            # Check file type is an image
            if not file.content_type.startswith('image/'):
                return jsonify({"message": "File must be an image"}), 400

            s3_client = app.config.get('S3_CLIENT')
            if file and s3_client:
                try:
                    # Generate a filename with user ID to ensure uniqueness
                    filename = secure_filename(file.filename)
                    # Extract extension
                    ext = filename.rsplit('.', 1)[1].lower() if '.' in filename else 'jpg'
                    s3_filename = f"profile_pictures/{current_user.id}/{uuid.uuid4()}.{ext}"
                    s3_bucket = app.config['S3_BUCKET']

                    s3_client.upload_fileobj(
                        file,
                        s3_bucket,
                        s3_filename,
                        ExtraArgs={'ContentType': file.content_type}
                    )
                    
                    # Generate file URL using the utility function
                    file_url = generate_s3_file_url(app.config, s3_filename)
                    
                    # Update user's profile_picture field
                    current_user.profile_picture = file_url
                    db.session.commit()
                    
                    return jsonify({
                        "message": "Profile picture updated successfully",
                        "profile_picture": file_url
                    }), 200
                    
                except Exception as e:
                    app.logger.error(f"Error uploading profile picture to S3: {e}")
                    return jsonify({"message": "Error uploading file to S3."}), 500
            elif not s3_client:
                return jsonify({"message": "File storage (S3) is not configured on the server."}), 500
            else:
                return jsonify({"message": "Invalid file."}), 400
            
        if app.config.get('TESTING', False) or app.config.get('DEBUG', False):
            @app.route('/api/v1/test-setup/reset-user-state', methods=['POST'])
            def reset_user_state_endpoint():
                try:
                    data = request.get_json()
                    if not data:
                        return jsonify({"message": "Request body must be JSON"}), 400

                    username = data.get('username')
                    desired_state = data.get('desired_state')

                    if not username or not desired_state:
                        return jsonify({"message": "Missing username or desired_state"}), 400

                    user = User.query.filter_by(username=username).first()
                    if not user:
                        if username == 'testuser': # Only auto-create testuser
                            user = User(username=username, email=f"{username}@example.com")
                            db.session.add(user)
                        else:
                            return jsonify({"message": f"User {username} not found."}), 404
                    
                    # Update password (hash it!)
                    if 'password' in desired_state:
                        user.password_hash = generate_password_hash(
                            desired_state['password'],
                            method='pbkdf2:sha256'  # Explicitly set hashing method
                        )

                    if 'invites_left' in desired_state:
                        user.invites_left = desired_state['invites_left']
                    
                    # Handle user_type if provided, defaulting to USER
                    if 'user_type' in desired_state:
                        try:
                            user_type_enum = UserType[desired_state['user_type'].upper()]
                            user.user_type = user_type_enum
                        except KeyError:
                            # Keep existing or default if invalid type provided
                            pass # Or return a 400 error
                    elif not user.user_type: # If newly created and not set
                        user.user_type = UserType.USER

                    # Handle is_active conceptually - Flask-Login's UserMixin handles this by default as True
                    # If you add an 'is_active' boolean field to your User model, you can set it here:
                    # if 'is_active' in desired_state and hasattr(user, 'is_active'):
                    # user.is_active = desired_state['is_active']
                    
                    # Clear existing invite codes for the user before potentially creating a new one
                    if username == 'testuser': # Or more generally, if specified in desired_state
                        InviteCode.query.filter_by(issuer_id=user.id).delete()
                        # Ensure Post deletion or other cleanups are also here if needed for 'testuser'
                        # Post.query.filter_by(user_id=user.id).delete()
                        app.logger.info(f"Test setup: Cleared existing invite codes for user '{username}'.")

                    # Create a new default invite code if requested
                    if desired_state.get('create_default_invite', True):
                        default_invite = InviteCode(issuer_id=user.id)
                        db.session.add(default_invite)
                        app.logger.info(f"Test setup: Created default invite code for user '{username}'.")

                    db.session.commit()
                    app.logger.info(f"Test setup: User '{username}' state reset. Committed to DB.")

                    # Diagnostic log: Query invites for the user immediately after commit
                    if username == 'testuser':
                        final_invites_count = InviteCode.query.filter_by(issuer_id=user.id, is_used=False).count()
                        app.logger.info(f"Test setup: DIAGNOSTIC - User '{username}' has {final_invites_count} unused invite(s) in DB after commit.")

                    return jsonify({"message": f"User {username} state reset successfully"}), 200

                except Exception as e:
                    db.session.rollback()
                    app.logger.error(f"Error in reset_user_state_endpoint: {str(e)}")
                    return jsonify({"message": "Internal server error during state reset", "error": str(e)}), 500

        return app # Return the app instance if setup is successful
    except Exception as e: # Catch exceptions during app creation
        print(f"CRITICAL ERROR during Flask app creation (config: {config_name}): {e}")
        import traceback
        print(traceback.format_exc()) # Print full traceback for debugging
        return None # Return None as expected by the calling code

# Create app instance for Gunicorn/WSGI server
# FLASK_CONFIG should be 'production' in the Heroku environment.
# If FLASK_CONFIG is not set, it defaults to 'production' here.
application = create_app(os.getenv('FLASK_CONFIG', 'production'))

if __name__ == '__main__':
    # Use the 'config_name' from environment variable or default to 'development'
    config_name = os.environ.get('FLASK_CONFIG', 'development')
    app = create_app(config_name)

    # Define host and port, allowing overrides from environment variables
    host = os.environ.get('FLASK_RUN_HOST', '127.0.0.1')
    try:
        port = int(os.environ.get('FLASK_RUN_PORT', '5001'))
    except ValueError:
        port = 5001 # Default port if parsing fails

    print(f"INFO: Starting Flask app with '{config_name}' configuration on {host}:{port}")
    app.run(host=host, port=port)
