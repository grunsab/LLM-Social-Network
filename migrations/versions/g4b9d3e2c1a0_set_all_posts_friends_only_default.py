"""Set all posts to friends-only and document default privacy change

Revision ID: g4b9d3e2c1a0
Revises: f3a8c2e1b9d4
Create Date: 2026-08-04 00:00:00.000000

"""
from alembic import op


# revision identifiers, used by Alembic.
revision = 'g4b9d3e2c1a0'
down_revision = 'f3a8c2e1b9d4'
branch_labels = None
depends_on = None


def upgrade():
    # Make every existing post visible only to the author and their friends.
    # New posts default to FRIENDS in the application layer (model + API + UI).
    op.execute("UPDATE post SET privacy = 'FRIENDS'")


def downgrade():
    # Cannot restore prior per-post privacy. No-op intentionally.
    pass
