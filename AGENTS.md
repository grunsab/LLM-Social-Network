# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Development Commands

### Backend (Flask)
```bash
# Setup virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Run development server
./run_dev_server.sh
# Or manually:
export FLASK_APP=app.py
export FLASK_ENV=development
export FLASK_DEBUG=1
python app.py

# Run tests
pytest

# Database migrations
flask db init      # Initialize migrations (already done)
flask db migrate   # Create new migration
flask db upgrade   # Apply migrations
```

### Frontend (React)
```bash
cd frontend

# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Run linting
npm run lint

# Run tests
npm test

# Run Cypress tests
npm run cypress:open  # Interactive mode
npm run cypress:run   # Headless mode
```

### Deployment
```bash
# Heroku deployment (from root)
npm run heroku-postbuild  # Builds frontend
```

## Architecture Overview

### Tech Stack
- **Backend**: Flask with Flask-RESTful API
- **Frontend**: React with Vite, React Router
- **Database**: SQLAlchemy ORM (PostgreSQL in production, SQLite in development)
- **Storage**: AWS S3/R2 for file uploads (profile pictures, Ampersounds)
- **Authentication**: Flask-Login with bcrypt password hashing
- **Testing**: pytest (backend), Vitest + Cypress (frontend)

### API Structure
The application uses a RESTful API pattern with resources organized in `/resources/`:
- Authentication: `/api/v1/auth/*` (register, login, logout)
- Posts: `/api/v1/posts/*` (CRUD operations, likes)
- Comments: `/api/v1/comments/*`
- Profiles: `/api/v1/profiles/*` (including picture upload)
- Friendships: `/api/v1/friendships/*` (friend requests)
- Feed: `/api/v1/feed` (personalized content)
- Ampersounds: `/api/v1/ampersounds/*` (audio clips)
- Categories: `/api/v1/categories/*`
- Reports: `/api/v1/reports/*`
- Notifications: `/api/v1/notifications/*`

### Key Models
- **User**: Core user model with authentication, profile pictures, friend relationships
- **Post**: Content with classification scores, privacy settings (public/friends-only)
- **Comment**: Nested comments on posts with visibility controls
- **Ampersound**: Audio clips with approval workflow
- **FriendRequest**: Friend connection system with pending/accepted/rejected states
- **Report**: Content reporting system for moderation

### Content Classification
Posts are automatically classified into categories using the Gemma3 model via DeepInfra API. Categories and their scores are stored as JSON in the Post model.

### Environment Variables
Key environment variables required:
- `SECRET_KEY`: Flask secret key
- `DATABASE_URL`: PostgreSQL connection string
- `S3_BUCKET`, `S3_KEY`, `S3_SECRET_ACCESS_KEY`: AWS S3/R2 credentials
- `S3_ENDPOINT_URL`: Custom S3 endpoint (for R2)
- `DEEPINFRA_API_KEY`: For content classification
- `OPENAI_API_KEY`: For image generation features
- `RUNWARE_API_KEY`: For image remixing with Flux Kontext Dev

### Frontend State Management
- Authentication state managed via React Context (`AuthContext`)
- API calls use fetch with proper authentication headers
- Protected routes check authentication status

### File Upload Flow
1. Frontend sends file to `/api/v1/profiles/upload_picture`
2. Backend validates file type and size
3. File uploaded to S3/R2 with unique name
4. URL stored in database
5. Frontend updates to show new picture

### Testing Approach
- Backend: pytest with Flask test client
- Frontend: Vitest for unit tests, Cypress for E2E tests
- Test fixtures and mocks available in respective test directories