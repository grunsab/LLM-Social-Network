# Simple Social Network with Post Classification

This is a basic Flask-based social network application where user posts are classified into categories using the Gemma3 model.
The application learns user interests based on the categories of their posts and provides a personalized feed.

## Features

*   User Registration and Login
*   Create Posts
*   View a feed of all posts
*   View a personalized feed based on learned interests
*   View user profiles with their posts and inferred interests
*   Profile picture upload and management
*   Post privacy controls (public/friends-only)
*   Friend request system
*   Ampersound sound clips sharing
*   Post classification

## Setup

1.  **Clone the repository:**
    ```bash
    git clone <your-repo-url>
    cd <repo-directory>
    ```

2.  **Create a virtual environment (recommended):**
    ```bash
    python -m venv venv
    source venv/bin/activate  # On Windows use `venv\Scripts\activate`
    ```

3.  **Install dependencies:**
    ```bash
    pip install -r requirements.txt
    ```

4.  **Run the application:**
    ```bash
    python app.py
    ```
    The application will be available at `http://127.0.0.1:5000`.


## Database

The application uses SQLite by default (`social_network.db`). The database schema is created automatically when `app.py` is first run.

## License

This project is distributed under the GNU Affero General Public License v3.0. See `LICENSE` for the full license text.
