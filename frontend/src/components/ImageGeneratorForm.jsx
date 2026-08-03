import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Spinner from './Spinner';
import './ImageGeneratorForm.css'; // We'll create this CSS file next

function ImageGeneratorForm({ onImagePostCreated }) {
  const { currentUser } = useAuth();
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!prompt.trim()) {
      setError('Prompt cannot be empty.');
      return;
    }
    setError('');
    setSuccessMessage('');
    setLoading(true);

    try {
      const response = await fetch('/api/v1/generate_image', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Credentials 'include' should be handled by default fetch behavior or AuthContext if needed for CSRF
        },
        body: JSON.stringify({ prompt }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Failed to generate image.');
      }

      setSuccessMessage(`Image generated and posted successfully! Post ID: ${data.post_id}`);
      setPrompt(''); // Clear prompt on success
      if (onImagePostCreated) {
        onImagePostCreated(data.post_id, data.image_url); // Notify parent about the new post
      }
    } catch (err) {
      console.error("Image generation error:", err);
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  if (!currentUser) {
    return null; // Or a message indicating login is required
  }

  return (
    <div className="card image-generator-form-container">
      <h4>Generate Image & Post</h4>
      <p className="image-generator-limit-hint">Up to 100 generations per day.</p>
      {error && <p className="error-message">{error}</p>}
      {successMessage && <p className="success-message">{successMessage}</p>}
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="image-prompt">Enter your prompt:</label>
          <textarea
            id="image-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g., A futuristic cityscape at sunset"
            rows="3"
            disabled={loading}
          />
        </div>
        <button type="submit" disabled={loading} className="button-primary">
          {loading ? <Spinner inline={true} size="small" /> : 'Generate & Post Image'}
        </button>
      </form>
    </div>
  );
}

export default ImageGeneratorForm;
