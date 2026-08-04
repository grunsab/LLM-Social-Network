import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useAuth } from '../context/AuthContext'; // To ensure user is logged in, though ProtectedRoute handles page access
import Spinner from './Spinner'; // Implied import for Spinner component
import { useAmpersoundAutocomplete } from '../hooks/useAmpersoundAutocomplete'; // Import the custom hook
import { FaPlay } from 'react-icons/fa'; // Import play icon for preview

function CreatePostForm({ onPostCreated }) { // Accept callback to refresh post list
  const { currentUser } = useAuth();
  const [content, setContent] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [privacy, setPrivacy] = useState('FRIENDS'); // Default: friends-only
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // State for autocomplete removed - now handled by the hook
  const textareaRef = useRef(null); // Keep ref for the textarea

  // Use the custom hook
  const {
    suggestions,
    showSuggestions,
    loadingSuggestions,
    suggestionListProps,
    handleContentChange: hookHandleContentChange,
    handleSuggestionClick: hookHandleSuggestionClick,
    hideSuggestions
  } = useAmpersoundAutocomplete(textareaRef);

  // State for preview playback
  const [previewAudio, setPreviewAudio] = useState(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  // Cleanup preview audio on unmount or when previewAudio state changes
  useEffect(() => {
    const audioToClean = previewAudio; // Capture the instance for this effect closure
    return () => {
        if (audioToClean) {
            console.log('CreatePostForm.jsx: Cleaning up preview audio:', audioToClean.src);
            audioToClean.pause();
            audioToClean.onended = null;
            audioToClean.onerror = null;
            audioToClean.onplaying = null; // Also clear onplaying
            // audioToClean.src = ''; // Optional: to forcefully release resources
        }
    };
  }, [previewAudio]); // Re-run when previewAudio state variable itself changes

  // Wrap the hook's content change handler to also update local state
  const handleLocalContentChange = (event) => {
    hookHandleContentChange(event, setContent); // Pass setter to the hook
    // Stop preview if user types
    if (previewAudio) previewAudio.pause();
    setPreviewAudio(null);
  };

  // Wrap the hook's suggestion click handler
  const handleLocalSuggestionClick = (suggestion) => { 
    hookHandleSuggestionClick(suggestion.tag, content, setContent); // Insert tag, hide suggestions, schedule focus

    // Delay playing the sound slightly to allow focus changes from the hook to settle.
    setTimeout(() => {
      const pseudoEvent = { stopPropagation: () => {} };
      // handlePreviewSound will stop any currently playing audio and then play the new one if URL is provided.
      // It will also handle the case where suggestion.url is null/undefined by just stopping previous audio.
      handlePreviewSound(pseudoEvent, suggestion.url || null);
    }, 50); // 50ms delay, adjust if needed
  };

  const handleImageChange = (event) => {
    if (event.target.files && event.target.files[0]) {
        // Check file size (e.g., < 3MB)
        if (event.target.files[0].size > 3 * 1024 * 1024) {
            setError('Image file is too large (max 3MB).');
            setImageFile(null);
            event.target.value = null; // Clear the input
        } else {
            setImageFile(event.target.files[0]);
            setError(''); // Clear error if size is okay
        }
    } else {
        setImageFile(null);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    hideSuggestions(); // Use hook's function to hide suggestions
    // Stop preview on submit
    if (previewAudio) previewAudio.pause();
    setPreviewAudio(null);
    if (!content && !imageFile) {
      setError('Post must contain text or an image.');
      return;
    }
    setError('');
    setLoading(true);

    const formData = new FormData();
    formData.append('content', content);
    formData.append('privacy', privacy);
    if (imageFile) {
      formData.append('image', imageFile);
    }

    try {
      const response = await fetch('/api/v1/posts', {
        method: 'POST',
        // No 'Content-Type': 'application/json' header for FormData
        // The browser will set the correct multipart/form-data header
        body: formData,
      });

      const data = await response.json(); // Still expect JSON response

      if (!response.ok) {
        setError(data.message || 'Failed to create post.');
      } else {
        // Post created successfully
        console.log('Post created:', data.post);
        // Clear the form
        setContent('');
        setImageFile(null);
        setPrivacy('FRIENDS');
        document.getElementById('post-image-input').value = null; // Clear file input
        
        // Notify parent component (Dashboard) to refresh posts
        if (onPostCreated) {
          onPostCreated(data.post); // Pass the new post data if needed
        }
      }
    } catch (err) {
      console.error("Create post API call failed:", err);
      setError('Failed to connect to the server. Please try again later.');
    } finally {
      setLoading(false);
    }
  };

  // Function to handle previewing a sound
  const handlePreviewSound = async (event, soundUrl) => {
    event.stopPropagation(); 
    setPreviewError('');
    
    if (previewAudio) { 
        previewAudio.pause();
        setPreviewAudio(null); // Triggers useEffect cleanup for the old audio object
    }

    if (!soundUrl) { // If no URL, we've already stopped/cleaned up. Nothing more to do.
        setIsPreviewLoading(false); // Ensure loading spinner (if any from preview button) is off
        return; 
    }

    setIsPreviewLoading(true);
    const newAudio = new Audio(soundUrl); // Create the new audio object

    newAudio.onplaying = () => {
        console.log("CreatePostForm.jsx: Preview playback started:", newAudio.src);
        // isPreviewLoading is set to false in the finally block after play() is called.
        // If play() succeeds, this confirms playback. If play() fails, finally still runs.
    };

    newAudio.onended = () => {
        console.log("CreatePostForm.jsx: Preview ended:", newAudio.src);
        // Only nullify state if this specific audio instance is still the current one.
        setPreviewAudio(currentInState => (currentInState === newAudio ? null : currentInState));
    };

    newAudio.onerror = (e) => {
        console.error("CreatePostForm.jsx: Audio preview error:", newAudio.src, e);
        setPreviewError('Error playing preview audio.'); 
        // Only nullify state if this specific audio instance is still the current one.
        setPreviewAudio(currentInState => (currentInState === newAudio ? null : currentInState));
    };

    try {
        // Set the new audio object into state, making it the "current" one.
        setPreviewAudio(newAudio);
        await newAudio.play(); 
        console.log("CreatePostForm.jsx: Preview play() successfully called for:", newAudio.src);
    } catch (err) {
        console.error("CreatePostForm.jsx: Error calling play() on preview audio:", newAudio.src, err);
        setPreviewError(`Could not play preview: ${err.message || 'Playback failed'}`);
        // If play() itself fails, ensure this newAudio (which was just set to state) is cleared.
        setPreviewAudio(currentInState => (currentInState === newAudio ? null : currentInState));
    } finally {
        // Regardless of play() success or failure, the "loading" phase (icon spinning) is over.
        setIsPreviewLoading(false);
    }
  };

  // Ensure user is logged in to see the form (though page is protected)
  if (!currentUser) return null; 

  return (
    // Use card styling for the form container
    <div className="card" style={{ marginBottom: '2rem' }}> 
      <h4>Create New Post</h4>
      {/* Display error above the form */}
      {error && <p className="error-message">{error}</p>}
      {previewError && <p className="error-message">Preview Error: {previewError}</p>} {/* Show preview error */}
      <form onSubmit={handleSubmit}>
        <div style={{ position: 'relative' }}> {/* Container for positioning suggestions */}
          <label htmlFor="post-content">What's on your mind?</label>
          <textarea 
            id="post-content"
            ref={textareaRef} // Attach ref
            value={content}
            onChange={handleLocalContentChange} // Use wrapped handler
            rows="4" /* Slightly taller */
            placeholder={`What's up, ${currentUser.username}?`}
            onBlur={hideSuggestions} // Hide on blur too
          />
          {/* Suggestions Dropdown */} 
          {showSuggestions && suggestions.length > 0 && (
            <ul 
                {...suggestionListProps}
                className="ampersound-suggestions" 
            >
                {loadingSuggestions && <li className="suggestion-item-loading">Loading...</li>}
                {!loadingSuggestions && suggestions.map((sugg, index) => (
                    <li 
                        key={index} 
                        className="suggestion-item" 
                        // onClickCapture removed from li
                    >
                        {/* Suggestion Info - Now handles insertion click */} 
                        <div 
                            style={{display: 'flex', alignItems: 'center', flexGrow: 1, cursor: 'pointer'}}
                            onClick={() => handleLocalSuggestionClick(sugg)} // Pass the full sugg object
                        >
                          <span>{sugg.tag}</span> 
                          <span className="suggestion-item-details">(by @{sugg.owner})</span>
                        </div>
                        {/* Preview Button - onClick unchanged, stopPropagation might not be needed but is harmless */}
                        {sugg.url && (
                            <button 
                                type="button" 
                                onClick={(e) => { e.stopPropagation(); handlePreviewSound(e, sugg.url); }}
                                className="suggestion-preview-button icon-button" 
                                title={`Preview ${sugg.tag}`}
                                disabled={isPreviewLoading}
                                style={{ marginLeft: '10px', padding: '2px 5px'}}
                            >
                                {isPreviewLoading ? <Spinner inline size="small"/> : <FaPlay size="0.8em"/>}
                            </button>
                        )}
                    </li>
                ))}
            </ul>
          )}
        </div>
        {/* Remove inline style from div */}
        <div> 
          <label htmlFor="post-image-input">Image (Optional, Max 3MB):</label>
          {/* Input type file might need custom styling later if desired */}
          <input 
            type="file"
            id="post-image-input"
            accept="image/*"
            onChange={handleImageChange}
            className="d-block mt-small" // Use utility classes
          />
        </div>
        {/* Use utility classes for layout */}
        <div className="mt-1 d-flex align-items-center gap-1"> 
          <div> {/* Wrap select and label */} 
            <label htmlFor="post-privacy" className="mb-small">Privacy:</label> {/* Use class */} 
            <select 
              id="post-privacy"
              value={privacy}
              onChange={(e) => setPrivacy(e.target.value)}
              className="w-auto" // Use class
            >
              <option value="FRIENDS">Friends Only</option>
              <option value="PUBLIC">Public</option>
            </select>
          </div>
          {/* Use utility class for margin */}
          <button type="submit" disabled={loading} className="ms-auto"> 
            {loading ? <Spinner inline={true} /> : 'Create Post'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default CreatePostForm; 