"""Add chat device phase 1 tables

Revision ID: 3f8c0f6d5a2b
Revises: 9d02a4f3de7b
Create Date: 2026-03-08 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = '3f8c0f6d5a2b'
down_revision = '9d02a4f3de7b'
branch_labels = None
depends_on = None


chat_device_kind_enum = sa.Enum('PRIMARY', 'LINKED', name='chatdevicekind')
chat_device_status_enum = sa.Enum('PENDING_LINK', 'ACTIVE', 'REVOKED', name='chatdevicestatus')
chat_device_link_session_status_enum = sa.Enum(
    'PENDING',
    'APPROVED',
    'EXPIRED',
    'CONSUMED',
    name='chatdevicelinksessionstatus'
)


def upgrade():
    bind = op.get_bind()
    is_postgres = bind.dialect.name == 'postgresql'

    # Explicitly check for PostgreSQL enums to avoid DuplicateObject errors
    if is_postgres:
        for enum_obj in [chat_device_kind_enum, chat_device_status_enum, chat_device_link_session_status_enum]:
            res = bind.execute(sa.text("SELECT 1 FROM pg_type WHERE typname = :name"), {"name": enum_obj.name}).fetchone()
            if not res:
                enum_obj.create(bind)
    else:
        chat_device_kind_enum.create(bind, checkfirst=True)
        chat_device_status_enum.create(bind, checkfirst=True)
        chat_device_link_session_status_enum.create(bind, checkfirst=True)

    # Use create_type=False for Postgres to prevent redundant CREATE TYPE in create_table
    if is_postgres:
        device_kind_col_type = postgresql.ENUM('PRIMARY', 'LINKED', name='chatdevicekind', create_type=False)
        device_status_col_type = postgresql.ENUM('PENDING_LINK', 'ACTIVE', 'REVOKED', name='chatdevicestatus', create_type=False)
        link_session_status_col_type = postgresql.ENUM('PENDING', 'APPROVED', 'EXPIRED', 'CONSUMED', name='chatdevicelinksessionstatus', create_type=False)
    else:
        device_kind_col_type = chat_device_kind_enum
        device_status_col_type = chat_device_status_enum
        link_session_status_col_type = chat_device_link_session_status_enum

    op.create_table(
        'chat_device',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('device_id', sa.String(length=64), nullable=False, unique=True),
        sa.Column('label', sa.String(length=120), nullable=True),
        sa.Column('device_kind', device_kind_col_type, nullable=False),
        sa.Column('status', device_status_col_type, nullable=False),
        sa.Column('identity_key_public', sa.Text(), nullable=False),
        sa.Column('signing_key_public', sa.Text(), nullable=False),
        sa.Column('signed_prekey_id', sa.Integer(), nullable=False),
        sa.Column('signed_prekey_public', sa.Text(), nullable=False),
        sa.Column('signed_prekey_signature', sa.Text(), nullable=False),
        sa.Column('linked_at', sa.DateTime(), nullable=True),
        sa.Column('last_seen_at', sa.DateTime(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.Column('revoked_at', sa.DateTime(), nullable=True),
        sa.Column('approved_by_device_id', sa.String(length=64), nullable=True),
        sa.ForeignKeyConstraint(['approved_by_device_id'], ['chat_device.device_id']),
        sa.ForeignKeyConstraint(['user_id'], ['user.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'device_id', name='uq_chat_device_user_device')
    )
    op.create_index('ix_chat_device_status', 'chat_device', ['status'], unique=False)
    op.create_index('ix_chat_device_user_id', 'chat_device', ['user_id'], unique=False)

    op.create_table(
        'chat_one_time_prekey',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('chat_device_id', sa.Integer(), nullable=False),
        sa.Column('prekey_id', sa.Integer(), nullable=False),
        sa.Column('public_key', sa.Text(), nullable=False),
        sa.Column('claimed_at', sa.DateTime(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['chat_device_id'], ['chat_device.id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('chat_device_id', 'prekey_id', name='uq_chat_one_time_prekey_device_prekey')
    )
    op.create_index('ix_chat_one_time_prekey_chat_device_id', 'chat_one_time_prekey', ['chat_device_id'], unique=False)

    op.create_table(
        'chat_transport_identity_mapping',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('chat_device_id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('spacetimedb_identity', sa.String(length=66), nullable=False),
        sa.Column('token_encrypted', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['chat_device_id'], ['chat_device.id']),
        sa.ForeignKeyConstraint(['user_id'], ['user.id']),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(
        'ix_chat_transport_identity_mapping_chat_device_id',
        'chat_transport_identity_mapping',
        ['chat_device_id'],
        unique=True
    )
    op.create_index(
        'ix_chat_transport_identity_mapping_spacetimedb_identity',
        'chat_transport_identity_mapping',
        ['spacetimedb_identity'],
        unique=True
    )
    op.create_index(
        'ix_chat_transport_identity_mapping_user_id',
        'chat_transport_identity_mapping',
        ['user_id'],
        unique=False
    )

    op.create_table(
        'chat_device_link_session',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('user_id', sa.Integer(), nullable=False),
        sa.Column('pending_device_id', sa.String(length=64), nullable=False),
        sa.Column('pending_identity_key_public', sa.Text(), nullable=False),
        sa.Column('pending_signing_key_public', sa.Text(), nullable=False),
        sa.Column('pending_signed_prekey_id', sa.Integer(), nullable=False),
        sa.Column('pending_signed_prekey_public', sa.Text(), nullable=False),
        sa.Column('pending_signed_prekey_signature', sa.Text(), nullable=False),
        sa.Column('status', link_session_status_col_type, nullable=False),
        sa.Column('approval_code_hash', sa.String(length=255), nullable=False),
        sa.Column('approved_by_device_id', sa.String(length=64), nullable=True),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['approved_by_device_id'], ['chat_device.device_id']),
        sa.ForeignKeyConstraint(['user_id'], ['user.id']),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(
        'ix_chat_device_link_session_pending_device_id',
        'chat_device_link_session',
        ['pending_device_id'],
        unique=False
    )
    op.create_index('ix_chat_device_link_session_status', 'chat_device_link_session', ['status'], unique=False)
    op.create_index('ix_chat_device_link_session_user_id', 'chat_device_link_session', ['user_id'], unique=False)


def downgrade():
    op.drop_index('ix_chat_device_link_session_user_id', table_name='chat_device_link_session')
    op.drop_index('ix_chat_device_link_session_status', table_name='chat_device_link_session')
    op.drop_index('ix_chat_device_link_session_pending_device_id', table_name='chat_device_link_session')
    op.drop_table('chat_device_link_session')

    op.drop_index('ix_chat_transport_identity_mapping_user_id', table_name='chat_transport_identity_mapping')
    op.drop_index(
        'ix_chat_transport_identity_mapping_spacetimedb_identity',
        table_name='chat_transport_identity_mapping'
    )
    op.drop_index('ix_chat_transport_identity_mapping_chat_device_id', table_name='chat_transport_identity_mapping')
    op.drop_table('chat_transport_identity_mapping')

    op.drop_index('ix_chat_one_time_prekey_chat_device_id', table_name='chat_one_time_prekey')
    op.drop_table('chat_one_time_prekey')

    op.drop_index('ix_chat_device_user_id', table_name='chat_device')
    op.drop_index('ix_chat_device_status', table_name='chat_device')
    op.drop_table('chat_device')

    bind = op.get_bind()
    chat_device_link_session_status_enum.drop(bind, checkfirst=True)
    chat_device_status_enum.drop(bind, checkfirst=True)
    chat_device_kind_enum.drop(bind, checkfirst=True)
