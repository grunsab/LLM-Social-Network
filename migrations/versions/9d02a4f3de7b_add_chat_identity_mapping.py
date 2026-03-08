"""Add chat identity mapping table

Revision ID: 9d02a4f3de7b
Revises: add_parent_post_id
Create Date: 2026-03-08 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '9d02a4f3de7b'
down_revision = 'add_parent_post_id'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'chat_identity_mapping',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('spacetimedb_identity', sa.String(length=66), nullable=False),
        sa.Column('token_encrypted', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['user.id'], ),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(
        op.f('ix_chat_identity_mapping_user_id'),
        'chat_identity_mapping',
        ['user_id'],
        unique=True
    )
    op.create_index(
        op.f('ix_chat_identity_mapping_spacetimedb_identity'),
        'chat_identity_mapping',
        ['spacetimedb_identity'],
        unique=True
    )


def downgrade():
    op.drop_index(op.f('ix_chat_identity_mapping_spacetimedb_identity'), table_name='chat_identity_mapping')
    op.drop_index(op.f('ix_chat_identity_mapping_user_id'), table_name='chat_identity_mapping')
    op.drop_table('chat_identity_mapping')
