"""Increase device_id and related columns length to 64

Revision ID: a7b8c9d0e1f2
Revises: 3f8c0f6d5a2b
Create Date: 2026-03-08 19:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a7b8c9d0e1f2'
down_revision = '3f8c0f6d5a2b'
branch_labels = None
depends_on = None


def upgrade():
    # chat_device table
    op.alter_column('chat_device', 'device_id',
               existing_type=sa.String(length=36),
               type_=sa.String(length=64),
               existing_nullable=False)
    op.alter_column('chat_device', 'approved_by_device_id',
               existing_type=sa.String(length=36),
               type_=sa.String(length=64),
               existing_nullable=True)
    
    # chat_device_link_session table
    op.alter_column('chat_device_link_session', 'pending_device_id',
               existing_type=sa.String(length=36),
               type_=sa.String(length=64),
               existing_nullable=False)
    op.alter_column('chat_device_link_session', 'approved_by_device_id',
               existing_type=sa.String(length=36),
               type_=sa.String(length=64),
               existing_nullable=True)


def downgrade():
    # Note: Shortening columns back might cause data truncation if long IDs exist
    op.alter_column('chat_device_link_session', 'approved_by_device_id',
               existing_type=sa.String(length=64),
               type_=sa.String(length=36),
               existing_nullable=True)
    op.alter_column('chat_device_link_session', 'pending_device_id',
               existing_type=sa.String(length=64),
               type_=sa.String(length=36),
               existing_nullable=False)
    op.alter_column('chat_device', 'approved_by_device_id',
               existing_type=sa.String(length=64),
               type_=sa.String(length=36),
               existing_nullable=True)
    op.alter_column('chat_device', 'device_id',
               existing_type=sa.String(length=64),
               type_=sa.String(length=36),
               existing_nullable=False)
