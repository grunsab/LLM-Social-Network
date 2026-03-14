"""add history backfill to chat device link session

Revision ID: c1f4b6a9d2e3
Revises: a7b8c9d0e1f2
Create Date: 2026-03-13 03:20:00.000000

"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'c1f4b6a9d2e3'
down_revision = 'a7b8c9d0e1f2'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        'chat_device_link_session',
        sa.Column('history_backfill_envelope', sa.Text(), nullable=True),
    )
    op.add_column(
        'chat_device_link_session',
        sa.Column('history_backfill_uploaded_at', sa.DateTime(), nullable=True),
    )


def downgrade():
    op.drop_column('chat_device_link_session', 'history_backfill_uploaded_at')
    op.drop_column('chat_device_link_session', 'history_backfill_envelope')
