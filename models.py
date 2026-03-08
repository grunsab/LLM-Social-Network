# from app import db, UserMixin # Removed import from app
from flask_login import UserMixin # Kept UserMixin import
from extensions import db # Added import from extensions
from datetime import datetime, timezone
import uuid # Add uuid for code generation
import enum # Import enum for FriendRequestStatus and PostPrivacy
from sqlalchemy import select, func, Date # Added for comments_count and UserImageGenerationStats
from sqlalchemy.orm import column_property # Added for comments_count

# Enum for Friend Request Status
class FriendRequestStatus(enum.Enum):
    PENDING = 'pending'
    ACCEPTED = 'accepted'
    REJECTED = 'rejected'

# Enum for Post Privacy
class PostPrivacy(enum.Enum):
    PUBLIC = 'public'  # Viewable by everyone
    FRIENDS = 'friends'  # Viewable only by friends

# Enum for User Types
class UserType(enum.Enum):
    USER = 'user'
    ADMIN = 'admin'

# Enum for Reportable Content Types
class ReportContentType(enum.Enum):
    POST = 'post'
    COMMENT = 'comment'
    AMPERSOUND = 'ampersound'

# Enum for Report Status
class ReportStatus(enum.Enum):
    PENDING = 'pending'
    RESOLVED_AUTO = 'resolved_auto' # For admin auto-actions
    RESOLVED_MANUAL = 'resolved_manual' # For other admin actions
    DISMISSED = 'dismissed'

# Enum for Ampersound Status
class AmpersoundStatus(enum.Enum):
    PENDING_APPROVAL = 'pending_approval'
    APPROVED = 'approved'
    REJECTED = 'rejected'

# Enum for Comment Visibility
class CommentVisibility(enum.Enum):
    PUBLIC = 'public'
    FRIENDS_ONLY = 'friends_only'

# New FriendRequest model
class FriendRequest(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    sender_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    receiver_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    status = db.Column(db.Enum(FriendRequestStatus), default=FriendRequestStatus.PENDING, nullable=False)
    timestamp = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    # Relationships to get User objects from IDs
    sender = db.relationship('User', foreign_keys=[sender_id], backref='sent_requests')
    receiver = db.relationship('User', foreign_keys=[receiver_id], backref='received_requests')

    # Ensure a unique pending request between two users
    __table_args__ = (db.UniqueConstraint('sender_id', 'receiver_id', name='uq_friend_request'),)

    def __repr__(self):
        return f'<FriendRequest {self.sender.username} -> {self.receiver.username}: {self.status.value}>'

class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(128))
    profile_picture = db.Column(db.String(512), nullable=True) # Add profile picture URL field
    user_type = db.Column(db.Enum(UserType), default=UserType.USER, nullable=False) # Added user_type
    posts = db.relationship('Post', backref='author', lazy=True)
    comments = db.relationship('Comment', backref='author', lazy=True)
    interests = db.relationship('UserInterest', backref='user', lazy=True)
    invites_left = db.Column(db.Integer, default=3, nullable=False) # Max 3 invites per user initially
    issued_codes = db.relationship('InviteCode', backref='issuer', lazy=True, foreign_keys='InviteCode.issuer_id')
    
    # New field for invite tracking
    invited_by_user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)

    # Relationships for invite tracking
    # User who invited this user
    inviter = db.relationship('User', remote_side=[id], backref='invited_users', foreign_keys=[invited_by_user_id])
    image_generation_stats = db.relationship('UserImageGenerationStats', backref='user', lazy=True)

    def __repr__(self):
        return f'<User {self.username}>'

    # --- Friendship Methods ---

    def get_friends(self):
        """Returns a list of users who are friends (accepted requests)."""
        friend_ids = self.get_friend_ids()
        return User.query.filter(User.id.in_(friend_ids)).all()
        
    def get_friend_ids(self):
        """Returns a set of friend IDs for the current user."""
        # Find accepted requests where the user is the sender
        sent_accepted = FriendRequest.query.with_entities(FriendRequest.receiver_id).filter_by(
            sender_id=self.id, 
            status=FriendRequestStatus.ACCEPTED
        ).all()
        friend_ids_sent = {req.receiver_id for req in sent_accepted}

        # Find accepted requests where the user is the receiver
        received_accepted = FriendRequest.query.with_entities(FriendRequest.sender_id).filter_by(
            receiver_id=self.id, 
            status=FriendRequestStatus.ACCEPTED
        ).all()
        friend_ids_received = {req.sender_id for req in received_accepted}

        # Combine IDs
        return friend_ids_sent.union(friend_ids_received)

    def is_friend(self, user):
        """Checks if this user is friends with another user (accepted request exists)."""
        return FriendRequest.query.filter(
            ((FriendRequest.sender_id == self.id) & (FriendRequest.receiver_id == user.id) |
             (FriendRequest.sender_id == user.id) & (FriendRequest.receiver_id == self.id)),
            FriendRequest.status == FriendRequestStatus.ACCEPTED
        ).count() > 0

    def unfriend(self, user):
        """Removes friendship (deletes the accepted FriendRequest)."""
        request = FriendRequest.query.filter(
            ((FriendRequest.sender_id == self.id) & (FriendRequest.receiver_id == user.id) |
             (FriendRequest.sender_id == user.id) & (FriendRequest.receiver_id == self.id)),
            FriendRequest.status == FriendRequestStatus.ACCEPTED
        ).first()
        if request:
            db.session.delete(request)
            return True
        return False

    # --- Friend Request Methods ---

    def send_friend_request(self, user):
        """Sends a friend request to another user."""
        if self == user or self.is_friend(user) or self.has_pending_request_to(user) or self.has_pending_request_from(user):
            return None # Cannot send request to self, existing friend, or if pending request exists either way
        request = FriendRequest(sender_id=self.id, receiver_id=user.id, status=FriendRequestStatus.PENDING)
        db.session.add(request)
        return request

    def accept_friend_request(self, request_id):
        """Accepts a friend request received by this user."""
        request = FriendRequest.query.filter_by(id=request_id, receiver_id=self.id, status=FriendRequestStatus.PENDING).first()
        if request:
            request.status = FriendRequestStatus.ACCEPTED
            # Optional: Delete any reverse pending request if it exists (user B sent request to user A after A sent to B)
            reverse_request = FriendRequest.query.filter_by(
                sender_id=request.receiver_id,
                receiver_id=request.sender_id,
                status=FriendRequestStatus.PENDING
            ).first()
            if reverse_request:
                db.session.delete(reverse_request)
            return True
        return False

    def reject_friend_request(self, request_id):
        """Rejects a friend request received by this user."""
        request = FriendRequest.query.filter_by(id=request_id, receiver_id=self.id, status=FriendRequestStatus.PENDING).first()
        if request:
            # Option 1: Set status to REJECTED (keeps history)
            # request.status = FriendRequestStatus.REJECTED
            # Option 2: Delete the request (simpler, less history)
            db.session.delete(request)
            return True
        return False

    def cancel_friend_request(self, user):
        """Cancels a friend request sent by this user to another user."""
        request = FriendRequest.query.filter_by(sender_id=self.id, receiver_id=user.id, status=FriendRequestStatus.PENDING).first()
        if request:
            db.session.delete(request)
            return True
        return False

    def has_pending_request_to(self, user):
        """Checks if this user has sent a pending request to another user."""
        return FriendRequest.query.filter_by(sender_id=self.id, receiver_id=user.id, status=FriendRequestStatus.PENDING).count() > 0

    def has_pending_request_from(self, user):
        """Checks if this user has received a pending request from another user."""
        return FriendRequest.query.filter_by(sender_id=user.id, receiver_id=self.id, status=FriendRequestStatus.PENDING).count() > 0

    def get_pending_received_requests(self):
        """Returns a list of pending friend requests received by this user."""
        return FriendRequest.query.filter_by(receiver_id=self.id, status=FriendRequestStatus.PENDING).order_by(FriendRequest.timestamp.desc()).all()

class ChatIdentityMapping(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False, unique=True, index=True)
    spacetimedb_identity = db.Column(db.String(66), nullable=False, unique=True, index=True)
    token_encrypted = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = db.Column(
        db.DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False
    )

    user = db.relationship('User', backref=db.backref('chat_identity_mapping', uselist=False, lazy=True))

class Comment(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, index=True, default=lambda: datetime.now(timezone.utc))
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    post_id = db.Column(db.Integer, db.ForeignKey('post.id'), nullable=False)
    visibility = db.Column(db.Enum(CommentVisibility), default=CommentVisibility.PUBLIC, nullable=False) # Added visibility
    # Add relationship to Notification with cascade delete
    notifications = db.relationship('Notification', backref='comment', lazy=True, cascade='all, delete-orphan')

    def __repr__(self):
        return f'<Comment {self.content[:30]}...>'

    def is_visible_to(self, user, post_author): # Added post_author argument
        """Check if a comment is visible to a given user."""
        # Comment author can always see their own comments
        if self.user_id == user.id:
            return True
        
        # If comment is public, anyone can see
        if self.visibility == CommentVisibility.PUBLIC:
            return True
            
        # If comment is friends_only, check friendship with comment author
        if self.visibility == CommentVisibility.FRIENDS_ONLY:
            # Check friendship between the viewing user and the comment author
            comment_author = User.query.get(self.user_id)
            if comment_author and comment_author.is_friend(user):
                return True
            # Also allow post author to see friends_only comments on their post
            if post_author and post_author.id == user.id:
                return True
        
        return False

# New PostLike model
class PostLike(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    post_id = db.Column(db.Integer, db.ForeignKey('post.id'), nullable=False)
    timestamp = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    # Ensure a user can only like a post once
    __table_args__ = (db.UniqueConstraint('user_id', 'post_id', name='uq_user_post_like'),)

    user = db.relationship('User', backref='post_likes')

    def __repr__(self):
        return f'<PostLike User: {self.user_id} Post: {self.post_id}>'

class Post(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    content = db.Column(db.Text, nullable=False)
    timestamp = db.Column(db.DateTime, index=True, default=lambda: datetime.now(timezone.utc))
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    image_url = db.Column(db.String(512), nullable=True) # URL for the image stored in S3
    classification_scores = db.Column(db.JSON, nullable=True) # Store combined classification results as JSON
    comments = db.relationship('Comment', backref='post', lazy=True, cascade='all, delete-orphan')
    category_scores = db.relationship('PostCategoryScore', lazy=True, cascade='all, delete-orphan')
    privacy = db.Column(db.Enum(PostPrivacy), default=PostPrivacy.PUBLIC, nullable=False)  # Default to public
    likes = db.relationship('PostLike', backref='post', lazy=True, cascade='all, delete-orphan')
    parent_post_id = db.Column(db.Integer, db.ForeignKey('post.id'), nullable=True)  # For tracking remixed posts
    parent_post = db.relationship('Post', remote_side=[id], backref='remixes')

    comments_count = column_property(
        select(func.count(Comment.id))
        .where(Comment.post_id == id)
        .correlate_except(Comment)
        .scalar_subquery()
    )

    likes_count = column_property(
        select(func.count(PostLike.id))
        .where(PostLike.post_id == id)
        .correlate_except(PostLike)
        .scalar_subquery()
    )

    def is_liked_by_user(self, user_id):
        """Checks if the post is liked by a specific user."""
        if not user_id: # Handle anonymous user case
            return False
        return db.session.query(PostLike.query.filter(
            PostLike.user_id == user_id,
            PostLike.post_id == self.id
        ).exists()).scalar()

    def __repr__(self):
        return f'<Post {self.content[:50]}...>'

    def is_visible_to(self, user):
        """Check if a post is visible to a given user based on privacy settings"""
        # Post author can always see their own posts
        if self.user_id == user.id:
            return True
            
        # If public, anyone can see
        if self.privacy == PostPrivacy.PUBLIC:
            return True
            
        # If friends-only, check friendship
        if self.privacy == PostPrivacy.FRIENDS:
            author = User.query.get(self.user_id)
            return author.is_friend(user)
            
        # Default fallback - shouldn't reach here with proper enum constraints
        return False

class PostCategoryScore(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    post_id = db.Column(db.Integer, db.ForeignKey('post.id', ondelete='CASCADE'), nullable=False)
    category = db.Column(db.String(50), nullable=False)
    score = db.Column(db.Float, default=0.0)

    def __repr__(self):
        return f'<PostCategoryScore {self.id} - Post: {self.post_id} - Category: {self.category} - Score: {self.score}>'

class UserInterest(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    category = db.Column(db.String(50), nullable=False, index=True)
    score = db.Column(db.Float, default=0.0)

    # Ensure a user has only one interest record per category
    __table_args__ = (db.UniqueConstraint('user_id', 'category', name='uq_user_category'),)

    def __repr__(self):
        return f'<UserInterest User: {self.user_id} Category: {self.category} Score: {self.score}>'

# New InviteCode model
class InviteCode(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(36), unique=True, nullable=False, default=lambda: str(uuid.uuid4()))
    issuer_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False) # User who created the code (issuer)
    is_used = db.Column(db.Boolean, default=False, nullable=False) 
    used_by_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True) # FK for who used the code
    timestamp = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    # Relationship to the user who used the code (links via used_by_id)
    used_by_user = db.relationship('User', foreign_keys=[used_by_id]) 

    def __repr__(self):
        used_status = f"Used by User ID: {self.used_by_id}" if self.used_by_id else "Not used"
        return f'<InviteCode {self.code} - Issued by User ID: {self.issuer_id} - {used_status}>' 

# New Ampersound model
class Ampersound(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    name = db.Column(db.String(100), nullable=False)  # The tag name, e.g., "hello" for "&hello"
    file_path = db.Column(db.String(512), nullable=False) # Path to the audio file
    timestamp = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    play_count = db.Column(db.Integer, default=0, nullable=False, index=True) # New field for tracking plays
    privacy = db.Column(db.String(50), default='public', nullable=False) # 'public' or 'friends'
    status = db.Column(db.Enum(AmpersoundStatus), default=AmpersoundStatus.PENDING_APPROVAL, nullable=False) # New status field

    # Define a unique constraint for user_id and name
    __table_args__ = (
        db.UniqueConstraint('user_id', 'name', name='uq_user_ampersound_name'),
    )

    # Relationship to User
    user = db.relationship('User', backref=db.backref('ampersounds', lazy=True))

    def __repr__(self):
        return f'<Ampersound {self.id} @{self.user.username}&{self.name} (Plays: {self.play_count}) Privacy: {self.privacy} Status: {self.status.value}>'

    def is_visible_to(self, user):
        """Check if an ampersound is visible to a given user."""
        # Ampersound owner can always see their own ampersounds, regardless of status
        if user and user.is_authenticated and self.user_id == user.id:
            return True

        # Admins can see all ampersounds
        if user and user.is_authenticated and user.user_type == UserType.ADMIN:
            return True

        # If ampersound is not approved, only owner (checked above) or admin (checked above) can see it.
        if self.status != AmpersoundStatus.APPROVED:
            return False

        # If approved and public, anyone can see
        if self.privacy == 'public':
            return True
            
        # If approved and friends-only, check friendship (user must be logged in)
        if self.privacy == 'friends':
            if not user: # Anonymous users cannot see friends-only content
                return False
            amp_author = User.query.get(self.user_id)
            if not amp_author: # Should not happen if data is consistent
                return False
            return amp_author.is_friend(user)
            
        return False

# Report Model
class Report(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    reporter_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    reported_user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    
    content_type = db.Column(db.Enum(ReportContentType), nullable=False)
    # ID of the Post, Comment, or Ampersound being reported
    content_id = db.Column(db.Integer, nullable=False) 
    
    reason = db.Column(db.Text, nullable=True) # Optional reason
    timestamp = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    status = db.Column(db.Enum(ReportStatus), default=ReportStatus.PENDING, nullable=False)

    reporter = db.relationship('User', foreign_keys=[reporter_id], backref='filed_reports')
    reported_user = db.relationship('User', foreign_keys=[reported_user_id], backref='reports_against')

    # To make querying for reported content easier, you could add specific FKs, 
    # but this requires knowing the content type first.
    # For now, content_id is generic. A helper method might be useful later.

    __table_args__ = (
        # A user can only report a specific piece of content once
        db.UniqueConstraint('reporter_id', 'content_type', 'content_id', name='uq_report_once_per_content'),
    )

    def __repr__(self):
        return f'<Report {self.id} by User {self.reporter_id} on {self.content_type.value} {self.content_id}>'

# Enum for Notification types
class NotificationType(enum.Enum):
    COMMENT = 'comment'

# Notification model
class Notification(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    actor_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    notification_type = db.Column(db.Enum(NotificationType), default=NotificationType.COMMENT, nullable=False)
    post_id = db.Column(db.Integer, db.ForeignKey('post.id'), nullable=False)
    comment_id = db.Column(db.Integer, db.ForeignKey('comment.id', ondelete='CASCADE'), nullable=False) # Added ondelete='CASCADE'
    timestamp = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    is_read = db.Column(db.Boolean, default=False, nullable=False)

    # Relationships
    user = db.relationship('User', foreign_keys=[user_id], backref='notifications_received')
    actor = db.relationship('User', foreign_keys=[actor_id], backref='notifications_sent')

# New model for tracking daily image generations by user
class UserImageGenerationStats(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    generation_date = db.Column(db.Date, nullable=False, default=lambda: datetime.now(timezone.utc).date())
    count = db.Column(db.Integer, default=0, nullable=False)

    __table_args__ = (db.UniqueConstraint('user_id', 'generation_date', name='uq_user_generation_date'),)

    def __repr__(self):
        return f'<UserImageGenerationStats UserID: {self.user_id} Date: {self.generation_date} Count: {self.count}>'
