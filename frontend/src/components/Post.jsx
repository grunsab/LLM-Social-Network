import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext'; // To check if current user is author for delete button
import { Link } from 'react-router-dom'; // Import Link
import './Post.css'; // Import the CSS file
import './ProfileImages.css'; // Import profile image styles
import Spinner from './Spinner'; // Import Spinner
import { FaTrashAlt, FaRegCommentDots, FaPlay, FaHeart, FaRegHeart, FaMagic } from 'react-icons/fa'; // Import Trash, Comment, Play, Heart, and Magic icons
import PlayableContentViewer from './PlayableContentViewer'; // Import the new component
import { useAmpersoundAutocomplete } from '../hooks/useAmpersoundAutocomplete'; // Import the hook
import ReportButton from './ReportButton'; // Import the ReportButton component
import { formatToLocalDateTime, formatToLocalDate } from '../utils/dateUtils';

function Post({ post, onDelete }) { // Accept post object and onDelete callback
  const { currentUser } = useAuth();
  const [comments, setComments] = useState([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [errorComments, setErrorComments] = useState('');
  const [showComments, setShowComments] = useState(false);
  const [newCommentContent, setNewCommentContent] = useState('');
  const [postingComment, setPostingComment] = useState(false);

  // State for likes
  const [likes, setLikes] = useState(post.likes_count || 0);
  const [isLiked, setIsLiked] = useState(false); // This would ideally be determined by checking if currentUser.id is in a list of users who liked the post
  const [likeInProgress, setLikeInProgress] = useState(false);

  // State for remix modal
  const [showRemixModal, setShowRemixModal] = useState(false);
  const [remixPrompt, setRemixPrompt] = useState('');
  const [remixInProgress, setRemixInProgress] = useState(false);
  const [remixError, setRemixError] = useState('');

  const commentTextareaRef = useRef(null); // Ref for comment textarea

  // Use autocomplete hook for comment input
  const {
    suggestions: commentSuggestions,
    showSuggestions: showCommentSuggestions,
    loadingSuggestions: loadingCommentSuggestions,
    suggestionListProps: commentSuggestionListProps,
    handleContentChange: hookHandleCommentChange, 
    handleSuggestionClick: hookHandleCommentSuggestionClick,
    hideSuggestions: hideCommentSuggestions
  } = useAmpersoundAutocomplete(commentTextareaRef);

  // State for comment preview playback
  const [commentPreviewAudio, setCommentPreviewAudio] = useState(null);
  const [isCommentPreviewLoading, setIsCommentPreviewLoading] = useState(false);
  const [commentPreviewError, setCommentPreviewError] = useState('');

  // Cleanup preview audio on unmount or when commentPreviewAudio state changes
  useEffect(() => {
    const audioToClean = commentPreviewAudio; // Capture the instance for this effect closure
    return () => {
        if (audioToClean) {
            console.log('Post.jsx: Cleaning up comment preview audio:', audioToClean.src);
            audioToClean.pause();
            audioToClean.onended = null;
            audioToClean.onerror = null;
            audioToClean.onplaying = null;
            // audioToClean.src = ''; 
        }
    };
  }, [commentPreviewAudio]); // Re-run when commentPreviewAudio state variable itself changes

  // Wrap hook's content change handler
  const handleLocalCommentChange = (event) => {
    hookHandleCommentChange(event, setNewCommentContent);
    // Stop preview if user types
    if (commentPreviewAudio) commentPreviewAudio.pause();
    setCommentPreviewAudio(null);
  };

  // Wrap hook's suggestion click handler
  const handleLocalCommentSuggestionClick = (suggestion) => { // Accept the full suggestion object
    hookHandleCommentSuggestionClick(suggestion.tag, newCommentContent, setNewCommentContent); // Insert the tag

    // Play the selected sound.
    // handlePreviewCommentSound will take care of stopping any previous preview.
    if (suggestion.url) {
      // Create a pseudo-event object as handlePreviewCommentSound expects an event.
      const pseudoEvent = { stopPropagation: () => {} };
      handlePreviewCommentSound(pseudoEvent, suggestion.url);
    } else {
      // If no URL, stop any current preview.
      if (commentPreviewAudio) {
        commentPreviewAudio.pause();
        setCommentPreviewAudio(null); // Triggers cleanup.
      }
    }
    // The hook's handleSuggestionClick already hides suggestions.
  };

  // Function to handle previewing a sound from comment suggestions
  const handlePreviewCommentSound = async (event, soundUrl) => {
    event.stopPropagation(); 
    setCommentPreviewError('');
    
    // If there's an existing audio object in state, pause it immediately.
    // Then, set the state to null, which will trigger the useEffect cleanup for the old object.
    if (commentPreviewAudio) { 
        commentPreviewAudio.pause();
        setCommentPreviewAudio(null);
    }

    if (!soundUrl) {
        setCommentPreviewError('No preview available.');
        return; // Don't set loading true if no URL
    }

    setIsCommentPreviewLoading(true);
    const newAudio = new Audio(soundUrl); // Create the new audio object

    newAudio.onplaying = () => {
        console.log("Post.jsx: Comment preview playback started:", newAudio.src);
    };

    newAudio.onended = () => {
        console.log("Post.jsx: Comment preview ended:", newAudio.src);
        // Only nullify state if this specific audio instance is still the current one.
        setCommentPreviewAudio(currentInState => (currentInState === newAudio ? null : currentInState));
    };

    newAudio.onerror = (e) => {
        console.error("Post.jsx: Comment audio preview error:", newAudio.src, e);
        setCommentPreviewError('Error playing comment preview audio.'); 
        // Only nullify state if this specific audio instance is still the current one.
        setCommentPreviewAudio(currentInState => (currentInState === newAudio ? null : currentInState));
    };

    try {
        // Set the new audio object into state, making it the "current" one.
        setCommentPreviewAudio(newAudio);
        await newAudio.play(); 
        console.log("Post.jsx: Comment preview play() successfully called for:", newAudio.src);
    } catch (err) {
        console.error("Post.jsx: Error calling play() on comment preview audio:", newAudio.src, err);
        setCommentPreviewError(`Could not play preview: ${err.message || 'Playback failed'}`);
        // If play() itself fails, ensure this newAudio (which was just set to state) is cleared.
        setCommentPreviewAudio(currentInState => (currentInState === newAudio ? null : currentInState));
    } finally {
        // Regardless of play() success or failure, the "loading" phase (icon spinning) is over.
        setIsCommentPreviewLoading(false);
    }
  };

  if (!post) return null; // Don't render if no post data

  const isAuthor = currentUser && currentUser.id === post.author?.id;
  
  // Debug comment count
  console.log(`Post ${post.id} - comments_count from API:`, post.comments_count);

  // Fetch comments function
  const fetchComments = async () => {
    if (!showComments) return; // Only fetch if section is open
    setLoadingComments(true);
    setErrorComments('');
    try {
      const response = await fetch(`/api/v1/posts/${post.id}/comments`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to fetch comments');
      }
      const data = await response.json();
      setComments(data || []); // API returns list directly
    } catch (error) {
      console.error("Error fetching comments:", error);
      setErrorComments(error.message || 'Could not load comments.');
    } finally {
      setLoadingComments(false);
    }
  };

  // Fetch comments when showComments becomes true
  useEffect(() => {
    if (showComments) {
      fetchComments();
    }
    // Intentionally not adding fetchComments to dependency array
    // to avoid re-fetching unless showComments changes from false to true.
  }, [showComments, post.id]); 

  // TODO: Fetch initial like status (isLiked) if the post object doesn't provide it directly
  // For now, we assume it starts as not liked by the current user unless the post data indicates otherwise.
  // A more robust solution would involve the backend sending a list of liker IDs or a boolean `currentUserLiked` field.

  const handleLike = async () => {
    if (likeInProgress) return;
    setLikeInProgress(true);

    const originalLikes = likes;
    const originalIsLiked = isLiked;

    // Optimistic update
    setLikes(isLiked ? likes - 1 : likes + 1);
    setIsLiked(!isLiked);

    try {
      const response = await fetch(`/api/v1/posts/${post.id}/like`, {
        method: 'POST',
        credentials: 'include', // Important for sending session cookies
      });
      const data = await response.json();
      if (!response.ok) {
        // Revert optimistic update on error
        setLikes(originalLikes);
        setIsLiked(originalIsLiked);
        console.error("Error liking/unliking post:", data.message);
        alert(`Error: ${data.message || 'Could not update like status.'}`);
      } else {
        // Confirm update from server response (optional, if server sends back new like count)
        setLikes(data.likes_count);
        setIsLiked(data.is_liked); // Assuming backend sends this
        console.log('Post like status updated', data);
      }
    } catch (error) {
      // Revert optimistic update on network error
      setLikes(originalLikes);
      setIsLiked(originalIsLiked);
      console.error("Network error when liking/unliking post:", error);
      alert('Network error. Could not update like status.');
    } finally {
      setLikeInProgress(false);
    }
  };

  const handleDelete = async () => {
    if (!isAuthor) return; // Should not happen if button isn't shown
    if (!window.confirm("Are you sure you want to delete this post?")) return;

    try {
        const response = await fetch(`/api/v1/posts/${post.id}`, {
            method: 'DELETE'
        });
        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.message || 'Failed to delete post');
        }
        console.log('Post deleted successfully');
        if (onDelete) {
            onDelete(post.id); // Notify parent to remove post from list
        }
    } catch (error) {
        console.error("Error deleting post:", error);
        alert(`Error deleting post: ${error.message}`); // Show error to user
    }
  };

  const handleRemix = async (e) => {
    e.preventDefault();
    if (!remixPrompt.trim()) return;
    
    setRemixInProgress(true);
    setRemixError('');
    
    try {
      const response = await fetch('/api/v1/remix_image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          post_id: post.id,
          prompt: remixPrompt
        })
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || 'Failed to remix image');
      }
      
      const result = await response.json();
      console.log('Image remixed successfully:', result);
      
      // Close modal and reset
      setShowRemixModal(false);
      setRemixPrompt('');
      
      // Optionally refresh the feed or show success message
      alert('Image remixed successfully! Check your profile for the new post.');
      
    } catch (error) {
      console.error("Error remixing image:", error);
      setRemixError(error.message);
    } finally {
      setRemixInProgress(false);
    }
  };

  const handlePostComment = async (event) => {
      event.preventDefault();
      hideCommentSuggestions(); // Hide suggestions
      // Stop preview on submit
      if (commentPreviewAudio) commentPreviewAudio.pause();
      setCommentPreviewAudio(null);
      if (!newCommentContent.trim()) return;
      setPostingComment(true);
      setErrorComments(''); // Clear previous comment errors
      
      try {
          const response = await fetch(`/api/v1/posts/${post.id}/comments`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: newCommentContent })
          });
          if (!response.ok) {
              const data = await response.json();
              throw new Error(data.message || 'Failed to post comment');
          }
          const newComment = await response.json();
          setComments(prevComments => [...prevComments, newComment]); // Add new comment to state
          setNewCommentContent(''); // Clear input field
      } catch (error) {
          console.error("Error posting comment:", error);
          setErrorComments(`Error posting comment: ${error.message}`); // Show error near comment input
      } finally {
          setPostingComment(false);
      }
  };

  const handleDeleteComment = async (commentId) => {
      if (!window.confirm("Are you sure you want to delete this comment?")) return;
      
      try {
          const response = await fetch(`/api/v1/comments/${commentId}`, {
              method: 'DELETE',
              credentials: 'include' // Added to ensure cookies (auth) are sent
          });
          if (!response.ok) {
              let errorMessage = 'Failed to delete comment';
              // Check content type before assuming JSON for error response
              if (response.headers.get("content-type")?.includes("application/json")) {
                  try {
                      const data = await response.json();
                      errorMessage = data.message || errorMessage;
                  } catch (e) {
                      console.error("Could not parse error response as JSON for comment deletion:", e);
                      // Keep default error message or use response status text if available
                      if (response.statusText) errorMessage = response.statusText;
                  }
              } else {
                  // Attempt to get text if not JSON, response might be plain text
                  try {
                      const textData = await response.text();
                      if (textData) {
                          errorMessage = textData;
                      } else if (response.statusText) {
                          errorMessage = response.statusText;
                      }
                  } catch (e) {
                      console.error("Could not read error response as text for comment deletion:", e);
                      if (response.statusText) errorMessage = response.statusText;
                  }
              }
              throw new Error(errorMessage);
          }
          setComments(prevComments => prevComments.filter(comment => comment.id !== commentId)); // Remove from state
      } catch (error) {   
          console.error("Error deleting comment:", error);
          alert(`Error deleting comment: ${error.message}`); // Show error
      }
  };

  return (
    // Apply card class and post class
    <div className="card post" data-cy={`post-${post.id}`}> 
      {/* Post Header */}
      <div className="post-header">
          <Link to={`/profile/${post.author?.username}`} className="post-author-link">
            <img 
                src={post.author?.profile_picture || '/default-profile.png'} 
                alt={post.author?.username || 'User'} 
                className="post-author-img" 
            />
            <span className="post-author-username">{post.author?.username || 'Unknown User'}</span>
          </Link>
          <span className="post-privacy">
            {post.privacy === 'FRIENDS' && (
              <span className="badge-friends-only" title="Friends Only"><i className="bi bi-people-fill"></i> Friends</span>
            )}
            {post.privacy === 'PUBLIC' && (
              <span className="badge-public" title="Public"><i className="bi bi-globe"></i> Public</span>
            )}
          </span>
          <span className="post-timestamp">{formatToLocalDateTime(post.timestamp)}</span>
      </div>

      {/* Post Image */}
      {post.image_url && (
        <img src={post.image_url} alt="Post image" className="post-image" />
      )}
      
      {/* Post Content - Updated to use PlayableContentViewer */}
      {post.content && 
        <div 
          className="post-content" 
          onClick={(e) => {
            console.log('[Post.jsx] Click detected on div.post-content. Event target:', e.target);
            console.log('[Post.jsx] Event currentTarget:', e.currentTarget);
          }}
        >
            { /* Log the content being passed to PlayableContentViewer */ }
            { console.log("Post.jsx - Rendering post.content for PlayableContentViewer:", post.content) }
            <PlayableContentViewer htmlContent={post.content} />
        </div>
      } 

      {/* Display Categories/Classifications */}
      {typeof post.classification_scores === 'object' && 
       post.classification_scores !== null && 
       Object.keys(post.classification_scores).length > 0 && (
        <div className="post-categories"> 
          <strong>Categories: </strong>
          {Object.entries(post.classification_scores)
            .filter(([_, score]) => score >= 0.5) // Filter categories with score >= 0.5
            .map(([category, score], index, arr) => (
              <span key={category}>
                <Link to={`/category/${encodeURIComponent(category)}`}>{category}</Link>
                {` (${score.toFixed(2)})`}
                {index < arr.length - 1 ? ', ' : ''} {/* Add comma separator */}
              </span>
            ))}
        </div>
      )}
      
      {/* Post Footer/Actions */}
      <div className="post-footer">
        <div className="post-actions">
            {/* Toggle Comments Button */}
            <button onClick={() => setShowComments(!showComments)} className="icon-button" title={showComments ? "Hide Comments" : "Show Comments"}>
                <FaRegCommentDots /> <span className="post-action-label">{showComments ? 'Hide' : 'Comments'} ({!showComments ? (post.comments_count || 0) : comments.length})</span>
            </button>

            {/* Like Button */}
            {currentUser && ( // Only show like button if user is logged in
              <button onClick={handleLike} disabled={likeInProgress} className="icon-button like-button" title={isLiked ? "Unlike" : "Like"}>
                {isLiked ? <FaHeart style={{ color: 'red' }} /> : <FaRegHeart />}
                <span className="post-action-label">{likes}</span>
              </button>
            )}
            {!currentUser && <span className="likes-count-logged-out">{likes} {likes === 1 ? 'Like' : 'Likes'}</span>}

            {/* Remix Button - only for posts with images */}
            {currentUser && post.image_url && (
              <button onClick={() => setShowRemixModal(true)} className="icon-button remix-button" title="Remix Image">
                <FaMagic /> <span className="post-action-label">Remix</span>
              </button>
            )}

            {/* Delete Button - only for author */}
            {isAuthor && (
                <button onClick={handleDelete} className="icon-button delete-button" title="Delete Post">
                    <FaTrashAlt /> <span className="post-action-label">Delete</span>
                </button>
            )}
            {/* Report Button for Post */}
            {!isAuthor && currentUser && (
                 <ReportButton 
                    contentId={post.id} 
                    contentType="post" 
                    reportedUserId={post.author?.id}
                />
            )}
        </div>
      </div>

      {/* --- Comments Section --- */}
      <div className="post-comments-section"> 
        {showComments && (
          <div>
            {loadingComments && <Spinner contained={true} />} {/* Use spinner for loading comments */} 
            {/* Use error-message class */} 
            {errorComments && !postingComment && <p className="error-message">{errorComments}</p>}
            
            {/* Comment List */}
            {!loadingComments && comments.map(comment => (
              // Apply comment class
              <div key={comment.id} className="comment"> 
                 <Link to={`/profile/${comment.author?.username}`} className="comment-author-link">
                    <img 
                        src={comment.author?.profile_picture || '/default-profile.png'} 
                        alt={comment.author?.username || 'User'} 
                        className="comment-author-img" 
                    />
                    {comment.author?.username || 'User'}
                 </Link>
                 {/* Comment Content - Updated to use PlayableContentViewer */} 
                 <div className="comment-content-wrapper">
                    <PlayableContentViewer htmlContent={comment.content} />
                 </div>
                 <span className="comment-timestamp">{formatToLocalDateTime(comment.timestamp)}</span>
                 {/* Comment Delete Button */} 
                 {currentUser && currentUser.id === comment.author?.id && (
                     <button 
                        onClick={() => handleDeleteComment(comment.id)} 
                        className="comment-delete-button icon-button">
                        <FaTrashAlt /> {/* Add Trash Icon */} 
                    </button>
                 )}
                 {/* Report Button for Comment */}
                 {currentUser && currentUser.id !== comment.author?.id && (
                    <ReportButton 
                        contentId={comment.id} 
                        contentType="comment" 
                        reportedUserId={comment.author?.id}
                    />
                 )}
              </div>
            ))}
            {!loadingComments && comments.length === 0 && !errorComments && <p>No comments yet.</p>} 

            {/* Add Comment Form */}
            <form onSubmit={handlePostComment} className="comment-form"> 
              {commentPreviewError && <p className="error-message">Preview Error: {commentPreviewError}</p>} {/* Show preview error */}
              <div style={{ position: 'relative' }}> {/* Wrapper for suggestions */}
                <textarea 
                  ref={commentTextareaRef} // Attach ref
                  value={newCommentContent}
                  onChange={handleLocalCommentChange} // Use wrapped handler
                  placeholder="Add a comment..."
                  rows="2"
                  required
                  onBlur={hideCommentSuggestions} // Hide on blur
                />
                {/* Comment Suggestions Dropdown */} 
                {showCommentSuggestions && commentSuggestions.length > 0 && (
                  <ul 
                      {...commentSuggestionListProps}
                      className="ampersound-suggestions" 
                  >
                      {loadingCommentSuggestions && <li className="suggestion-item-loading">Loading...</li>}
                      {!loadingCommentSuggestions && commentSuggestions.map((sugg, index) => (
                          <li 
                              key={index} 
                              className="suggestion-item" 
                          >
                              {/* Suggestion Info - Now handles insertion click */} 
                              <div 
                                  style={{display: 'flex', alignItems: 'center', flexGrow: 1, cursor: 'pointer'}}
                                  onClick={() => handleLocalCommentSuggestionClick(sugg)} // Pass the full sugg object
                              >
                                  <span>{sugg.tag}</span>
                                  <span className="suggestion-item-details">(by @{sugg.owner})</span>
                              </div>
                              {/* Preview Button - onClick unchanged */}
                              {sugg.url && (
                                  <button 
                                      type="button" 
                                      onClick={(e) => { e.stopPropagation(); handlePreviewCommentSound(e, sugg.url); }}
                                      className="suggestion-preview-button icon-button" 
                                      title={`Preview ${sugg.tag}`}
                                      disabled={isCommentPreviewLoading}
                                      style={{ marginLeft: '10px', padding: '2px 5px'}}
                                  >
                                      {isCommentPreviewLoading ? <Spinner inline size="small"/> : <FaPlay size="0.8em"/>}
                                  </button>
                              )}
                          </li>
                      ))}
                  </ul>
                )}
              </div>
              <button type="submit" disabled={postingComment}>
                {postingComment ? <Spinner inline={true} /> : 'Comment'} 
              </button>
              {errorComments && postingComment && <p className="error-message">{errorComments}</p>} 
            </form>
          </div>
        )}
      </div>

      {/* Remix Modal */}
      {showRemixModal && (
        <div className="modal-overlay" onClick={() => setShowRemixModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3>Remix Image</h3>
            <p>Describe how you want to transform this image:</p>
            <p style={{ fontSize: '0.9rem', opacity: 0.85, marginBottom: '0.75rem' }}>
              Limit: 2 remixes per day.
            </p>
            
            <form onSubmit={handleRemix}>
              {remixError && <p className="error-message">{remixError}</p>}
              
              <textarea
                value={remixPrompt}
                onChange={(e) => setRemixPrompt(e.target.value)}
                placeholder="e.g., 'make it look like a painting', 'add a sunset background', 'turn it into anime style'"
                rows="4"
                maxLength="500"
                required
                disabled={remixInProgress}
                style={{ width: '100%', marginBottom: '1rem' }}
              />
              
              <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
                <button 
                  type="button" 
                  onClick={() => setShowRemixModal(false)}
                  disabled={remixInProgress}
                >
                  Cancel
                </button>
                <button 
                  type="submit" 
                  disabled={remixInProgress || !remixPrompt.trim()}
                >
                  {remixInProgress ? <Spinner inline={true} /> : 'Remix'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default Post;