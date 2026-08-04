"""
Set ALL posts in the database to friends-only privacy.

Usage (from project root, with env/config pointing at the target DB):
    python scripts/set_all_posts_friends_only.py

On Heroku:
    heroku run python scripts/set_all_posts_friends_only.py -a <app-name>
"""
import os
import sys

project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.insert(0, project_root)

from sqlalchemy import text

from app import create_app, db


def set_all_posts_to_friends_only():
    # Prefer explicit FLASK_CONFIG; fall back to production when DATABASE_URL is set
    # (typical for Heroku), otherwise default/local config.
    config_name = os.getenv('FLASK_CONFIG')
    if not config_name:
        config_name = 'production' if os.getenv('DATABASE_URL') else 'default'

    app = create_app(config_name)

    with app.app_context():
        try:
            result = db.session.execute(
                text("UPDATE post SET privacy = 'FRIENDS' WHERE privacy != 'FRIENDS' OR privacy IS NULL")
            )
            db.session.commit()
            updated = result.rowcount if result.rowcount is not None and result.rowcount >= 0 else 'unknown'
            print(f"Successfully updated {updated} post(s) to friends-only.")
        except Exception as e:
            db.session.rollback()
            print(f"Error updating posts: {e}")
            raise


if __name__ == '__main__':
    set_all_posts_to_friends_only()
