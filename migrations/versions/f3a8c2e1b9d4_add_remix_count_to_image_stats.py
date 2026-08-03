"""Add remix_count to user_image_generation_stats

Revision ID: f3a8c2e1b9d4
Revises: c1f4b6a9d2e3
Create Date: 2026-08-02 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'f3a8c2e1b9d4'
down_revision = 'c1f4b6a9d2e3'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('user_image_generation_stats', schema=None) as batch_op:
        batch_op.add_column(
            sa.Column('remix_count', sa.Integer(), nullable=False, server_default='0')
        )


def downgrade():
    with op.batch_alter_table('user_image_generation_stats', schema=None) as batch_op:
        batch_op.drop_column('remix_count')
