import React, { useState, useEffect } from 'react';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Link,
  Navigate,
  NavLink
} from 'react-router-dom';

import { useAuth } from './context/AuthContext'; // Import useAuth
import { useChat } from './context/ChatContext';
import Login from './components/Login';
import Register from './components/Register';
import Dashboard from './components/Dashboard'; // Import Dashboard
import ProtectedRoute from './components/ProtectedRoute'; // Import ProtectedRoute
import Profile from './components/Profile'; // Import Profile component
import CategoryView from './components/CategoryView'; // Import CategoryView
import ManageInvites from './components/ManageInvites'; // Import ManageInvites
import FriendRequests from './components/FriendRequests'; // Import FriendRequests
import PopularAmpersoundsPage from './components/PopularAmpersoundsPage'; // Import new page
import Notifications from './components/Notifications'; // Import Notifications
import SinglePostPage from './components/SinglePostPage'; // Import SinglePostPage
import CreateAmpersoundFromYoutubePage from './components/pages/CreateAmpersoundFromYoutubePage'; // Import the new page
import ChatPage from './components/ChatPage';
import './App.css';
import './hooks/Autocomplete.css'; // Import autocomplete styles
import Spinner from './components/Spinner'; // Import Spinner

function App() {
  const { currentUser, loading, logout } = useAuth(); // Get user and logout
  const { totalUnread: totalChatUnread } = useChat();
  const [unreadCount, setUnreadCount] = useState(0);
  const [isNavOpen, setIsNavOpen] = useState(false); // State for mobile nav

  // Fetch unread notifications count when user logs in
  useEffect(() => {
    async function fetchUnread() {
      try {
        const resp = await fetch('/api/v1/notifications/unread_count', { credentials: 'include' });
        if (!resp.ok) return;
        const data = await resp.json();
        setUnreadCount(data.unread_count || 0);
      } catch (err) {
        console.error('Failed to fetch unread count', err);
      }
    }
    if (currentUser) fetchUnread();
  }, [currentUser]);

  // Handle logout directly in nav for simplicity here
  const handleLogout = async () => {
    await logout();
    // No need to navigate here, ProtectedRoute will handle redirect if on protected page
  };

  if (loading) {
      // Use contained spinner for initial app load
      return <Spinner contained={true} />; 
  }

  return (
    <Router>
      <nav>
        {/* Hamburger button for mobile */}
        <button className={`nav-toggle ${isNavOpen ? 'open' : ''}`} onClick={() => setIsNavOpen(!isNavOpen)} aria-label="Toggle navigation">
          {/* Simple hamburger icon using spans */}
          <span></span>
          <span></span>
          <span></span>
        </button>
        <ul className={isNavOpen ? 'nav-links nav-links-open' : 'nav-links'}>
          {/* Add App Title/Link */} 
          <li> 
            <Link to="/" className="nav-title">SocialNet</Link>
          </li>
          <li> {/* Public link to Popular Ampersounds */}
            <NavLink to="/popular-ampersounds" className={({ isActive }) => isActive ? "active" : ""}>Popular Sounds</NavLink>
          </li>

          {currentUser ? (
            <>
              <li>
                <NavLink to="/" className={({ isActive }) => isActive ? "active" : ""} end>Dashboard</NavLink>
              </li>
              <li>
                <NavLink 
                    to={`/profile/${currentUser.username}`}
                    className={({ isActive }) => isActive ? "active" : ""}
                >
                    My Profile
                </NavLink>
              </li>
              <li>
                <NavLink to="/manage-invites" className={({ isActive }) => isActive ? "active" : ""}>Manage Invites</NavLink>
              </li>
              <li>
                <NavLink to="/friend-requests" className={({ isActive }) => isActive ? "active" : ""}>Friend Requests</NavLink>
              </li>
              <li>
                <NavLink to="/chat" className={({ isActive }) => isActive ? "active" : ""}>
                  Chat{totalChatUnread > 0 && (
                    <span style={{ backgroundColor: '#2563eb', color: '#fff', borderRadius: '50%', padding: '0.2rem 0.5rem', marginLeft: '0.25rem', fontSize: '0.8rem' }}>
                      {totalChatUnread}
                    </span>
                  )}
                </NavLink>
              </li>
              <li>
                <NavLink to="/create-ampersound-youtube" className={({ isActive }) => isActive ? "active" : ""}>Create Ampersound (YouTube)</NavLink>
              </li>
              <li>
                <NavLink to="/notifications" className={({ isActive }) => isActive ? "active" : ""}>
                  Notifications{unreadCount > 0 && (
                    <span style={{ backgroundColor: 'red', color: '#fff', borderRadius: '50%', padding: '0.2rem 0.5rem', marginLeft: '0.25rem', fontSize: '0.8rem' }}>
                      {unreadCount}
                    </span>
                  )}
                </NavLink>
              </li>
              <li>
                <button onClick={handleLogout} className="logout-button">
                  Logout ({currentUser.username})
                </button>
              </li>
            </>
          ) : (
            <>
              <li>
                <NavLink to="/login" className={({ isActive }) => isActive ? "active" : ""}>Login</NavLink>
              </li>
              <li>
                <NavLink to="/register" className={({ isActive }) => isActive ? "active" : ""}>Register</NavLink>
              </li>
            </>
          )}
        </ul>
      </nav>

      <main className="main-content">
        <Routes>
          {/* Public routes */}
          <Route path="/login" element={!currentUser ? <Login /> : <Navigate replace to="/" />} />
          <Route path="/register" element={!currentUser ? <Register /> : <Navigate replace to="/" />} />
          <Route path="/popular-ampersounds" element={<PopularAmpersoundsPage />} /> {/* New public route */}
          <Route path="/posts/:postId" element={<SinglePostPage />} /> {/* Moved from protected to public */}

          {/* Protected routes */}
          <Route element={<ProtectedRoute />}>
             <Route path="/" element={<Dashboard />} />
             <Route path="/profile/:username" element={<Profile />} />
             <Route path="/category/:categoryName" element={<CategoryView />} />
             <Route path="/manage-invites" element={<ManageInvites />} />
             <Route path="/friend-requests" element={<FriendRequests />} />
             <Route path="/notifications" element={<Notifications />} />
             <Route path="/create-ampersound-youtube" element={<CreateAmpersoundFromYoutubePage />} /> {/* New protected route */}
             <Route path="/chat" element={<ChatPage />} />
          </Route>
          
           {/* Optional: Catch-all route for 404 */}
          {/* <Route path="*" element={<NotFound />} /> */}
        </Routes>
      </main>
    </Router>
  );
}

export default App;
