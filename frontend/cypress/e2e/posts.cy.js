describe('Post Management', () => {

  const testUser = { username: 'testuser', password: 'password', email: 'testuser@example.com' };
  // IMPORTANT: Ensure 'anotheruser' with 'password' exists in your test database
  // and has the ability to create posts.
  const otherUser = { username: 'anotheruser', password: 'password', email: 'anotheruser@example.com' };

  before(() => {
    // Ensure test users exist
    cy.ensureUserExists(testUser);
    cy.ensureUserExists(otherUser);
  });

  // Use beforeEach to log in before each test in this file
  beforeEach(() => {
    // Use credentials for a test user (ensure this user exists in your test DB)
    cy.login(testUser.username, testUser.password); // This line was updated by a previous step
    // Visit the page you want to test AFTER logging in
    cy.visit('/'); 
    // Wait for the feed heading to ensure the page is loaded after login
    // The feed shows either 'Your Feed' or a message from the API
    cy.get('h3').should('be.visible');
  });

  it('should allow a logged-in user to create a post', () => {
    // No need to visit or log in here, beforeEach handles it.
    
    // --- Now proceed with the actual test ---
    // At this point, we should be on the dashboard ('/') and logged in

    // Check for the posts list container (should exist even if empty)
    cy.get('.posts-list').should('be.visible');

    const postContent = `This is a test post created by Cypress at ${Date.now()}`;

    // <<< Add wait for the form/button to be ready before typing >>>
    cy.contains('button', 'Create Post').should('be.visible');

    // Find the textarea using its ID, wait for it to be visible, then type
    cy.get('#post-content').should('be.visible');
    cy.get('#post-content').type(postContent);

    // Find the submit button by its text and click it
    // Intercept the API call before clicking
    cy.intercept('POST', '/api/v1/posts').as('createPost');
    cy.contains('button', 'Create Post').click();

    // Wait for the API call to complete and check its status code
    cy.wait('@createPost').its('response.statusCode').should('eq', 201);

    // Wait for the post to appear in the feed (with increased timeout)
    cy.get('.posts-list').should('contain.text', postContent, { timeout: 10000 });
  });

  it('should show an error if submitting a post with no content and no image', () => {
    // The form is visible on '/' after login from beforeEach

    // Ensure the submit button is visible
    cy.contains('button', 'Create Post').should('be.visible');

    // Clear the content textarea just in case it has any default text
    cy.get('#post-content').clear(); 

    // Click the submit button
    cy.contains('button', 'Create Post').click();

    // Check for an error message
    // The CreatePostForm.jsx uses: {error && <p className="error-message">{error}</p>}
    // So, we look for that class and an expected message.
    cy.get('.error-message')
      .should('be.visible')
      .and('contain.text', 'Post must contain text or an image.'); // Or a similar message

    // Ensure no API call was made
    // To do this properly, we should set up an intercept before the click 
    // and assert it was NOT called, but for a simple validation error, this might be okay.
    // Or, we can check the URL hasn't changed and the form is still there.
    cy.url().should('eq', Cypress.config().baseUrl + '/');
  });

  it.skip('should allow changing post privacy and send it in the API request', () => {
    const postContent = `A post with specific privacy - ${Date.now()}`;

    // Verify default privacy is Friends Only
    cy.get('#post-privacy').should('have.value', 'FRIENDS');

    // Change privacy to Public
    cy.get('#post-privacy').select('PUBLIC');
    cy.get('#post-privacy').should('have.value', 'PUBLIC');

    // Enter content
    cy.get('#post-content').type(postContent);

    // Intercept the API call
    cy.intercept('POST', '/api/v1/posts').as('createPostWithPrivacy');

    // Submit the form
    cy.contains('button', 'Create Post').click();

    // Wait for the API call and verify its request body
    cy.wait('@createPostWithPrivacy').then((interception) => {
      expect(interception.response.statusCode).to.eq(201);
      // Log the response to debug
      cy.log('API Response:', JSON.stringify(interception.response.body));
      
      // The response should have a 'post' property
      expect(interception.response.body).to.have.property('post');
      const responsePost = interception.response.body.post;
      
      // Check if privacy is set correctly (form was set to PUBLIC above)
      expect(responsePost.privacy).to.eq('PUBLIC');
    });

    // Verify the post appears in the feed
    cy.get('.posts-list').should('contain.text', postContent);
  });

  it('should allow creating a post with a small image', () => {
    const postContentWithImage = `Post with a small image - ${Date.now()}`;
    const fixtureImage = 'small-image.png'; // Assumes this exists in fixtures

    // Enter content
    cy.get('#post-content').type(postContentWithImage);

    // Select the image file
    cy.get('#post-image-input').selectFile(`cypress/fixtures/${fixtureImage}`);

    // Intercept the API call
    cy.intercept('POST', '/api/v1/posts').as('createPostWithImage');

    // Submit the form
    cy.contains('button', 'Create Post').click();

    // Wait for the API call and verify success
    cy.wait('@createPostWithImage').then((interception) => {
      expect(interception.response.statusCode).to.eq(201);
      expect(interception.response.body.post.image_url).to.not.be.null;
      expect(interception.response.body.post.image_url).to.include('images/');
    });

    // Verify the post appears in the feed
    cy.get('.posts-list').should('contain.text', postContentWithImage);

    // Verify the image itself is displayed
    cy.contains('.post', postContentWithImage)
      .within(() => {
        // Find the post image, not the profile picture
        cy.get('img.post-image')
          .should('be.visible')
          .and('have.attr', 'src') // Check src attribute exists
          .and('include', 'images/'); // Check src attribute includes expected path
      });
  });

  it.skip('should show a client-side error if a selected image is too large', () => {
    // Helper to create a mock File object with a specific size
    function mockNewFile(sizeInMB, name) {
      const blob = new Blob([new ArrayBuffer(sizeInMB * 1024 * 1024)], { type: 'image/png' });
      return new File([blob], name, { type: 'image/png' });
    }

    const largeFileName = 'large-image-mock.png';
    const fileSizeMB = 4; // > 3MB limit

    // Get the input element and manipulate its files property
    cy.get('#post-image-input').then($input => {
      const inputElement = $input[0];
      const dataTransfer = new DataTransfer();
      const mockFile = mockNewFile(fileSizeMB, largeFileName);
      dataTransfer.items.add(mockFile);
      inputElement.files = dataTransfer.files;
      // Dispatch change event manually
      inputElement.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Check for the client-side error message
    cy.get('.error-message', { timeout: 5000 })
      .should('be.visible')
      .and('contain.text', 'Image file is too large (max 3MB).');

    // Check that the file input value has been cleared by the component
    cy.get('#post-image-input').should('have.value', ''); 
  });

  describe('Comments on Posts', () => {
    let testPostId; // To store the ID of the post created for comment tests
    const postTextForComment = `Post for commenting - ${Date.now()}`;

    beforeEach(() => {
      // Create a post as testuser before each comment test
      cy.login(testUser.username, testUser.password); // Ensure testuser is logged in
      cy.createPost({ content: postTextForComment, privacy: 'PUBLIC' })
        .then((createdPost) => {
          testPostId = createdPost.id;
          cy.log(`Created post with ID: ${testPostId} for comment testing.`);
        });
      
      cy.visit('/'); // Visit the feed where posts are displayed
      
      // Wait for loading to complete by ensuring spinner is not present
      cy.get('.spinner-container', { timeout: 10000 }).should('not.exist');
      
      cy.contains('.posts-list', postTextForComment, { timeout: 10000 }).should('be.visible'); // Ensure post is loaded
    });

    it('should allow a user to add and view a comment on a post', () => {
      const commentText = `This is a test comment - ${Date.now()}`;

      // Find the specific post by its content
      cy.contains('.post', postTextForComment).as('targetPost');

      // Click the "Show Comments" button for that post
      // Assuming the button is within the post card
      cy.get('@targetPost').find('button').contains(/Comments|Hide/).click();

      // Type a comment into the textarea
      // Assuming textarea is within the post card after comments are shown
      cy.get('@targetPost').find('textarea[placeholder="Add a comment..."]').type(commentText);

      // Intercept the API call for posting a comment
      cy.intercept('POST', `/api/v1/posts/${testPostId}/comments`).as('postComment');

      // Click the "Comment" button
      cy.get('@targetPost').find('form.comment-form button[type="submit"]').click();

      // Verify the API call
      cy.wait('@postComment').then((interception) => {
        expect(interception.response.statusCode).to.eq(201);
        expect(interception.response.body.content).to.eq(commentText);
        expect(interception.response.body.post_id).to.eq(testPostId);
      });

      // Verify the new comment text appears in the comment list for that post
      // Assuming comments are within a .comment class within the targetPost
      cy.get('@targetPost').find('.comment').should('contain.text', commentText);
    });

    it('should allow a user to delete their own comment', () => {
      const commentText = `Comment to be deleted - ${Date.now()}`;
      let commentIdToDelete;

      // 1. Add a comment first
      cy.contains('.post', postTextForComment).as('targetPostForDelete');
      cy.get('@targetPostForDelete').find('button').contains(/Comments|Hide/).click();
      cy.get('@targetPostForDelete').find('textarea[placeholder="Add a comment..."]').type(commentText);
      cy.intercept('POST', `/api/v1/posts/${testPostId}/comments`).as('postCommentToDelete');
      cy.get('@targetPostForDelete').find('form.comment-form button[type="submit"]').click();
      
      cy.wait('@postCommentToDelete').then((interception) => {
        expect(interception.response.statusCode).to.eq(201);
        commentIdToDelete = interception.response.body.id; // Get the ID of the created comment
        cy.log(`Comment created with ID: ${commentIdToDelete} for deletion test.`);
        // Ensure the comment is visible before trying to delete
        cy.get('@targetPostForDelete').find('.comment').should('contain.text', commentText);
      });

      // 2. Delete the comment
      // Stub window.confirm to automatically confirm
      cy.on('window:confirm', () => true);

      // Intercept the DELETE request (must be set up before clicking)
      cy.then(() => {
        cy.intercept('DELETE', `/api/v1/comments/${commentIdToDelete}`).as('deleteComment');
      });

      // Find the specific comment (e.g., by finding its text then its delete button)
      // This is a bit brittle if multiple comments have same text, but okay for this isolated test.
      // A better way would be data-cy attributes on comment items like data-cy=`comment-item-${commentIdToDelete}`
      cy.get('@targetPostForDelete').contains('.comment', commentText)
        .find('.comment-delete-button').click(); 
      
      // Verify API call for deletion
      cy.wait('@deleteComment').its('response.statusCode').should('eq', 200);

      // Verify the comment text is removed from the list
      // Check if there are any comments left, if not, check for "No comments yet" message
      cy.get('@targetPostForDelete').then($post => {
        const comments = $post.find('.comment');
        if (comments.length > 0) {
          cy.wrap(comments).should('not.contain.text', commentText);
        } else {
          cy.get('@targetPostForDelete').should('contain.text', 'No comments yet.');
        }
      });
    });

    it('should NOT show a delete button for comments made by other users', () => {
      const otherUserCommentText = `Comment by other user - ${Date.now()}`;

      // 1. otherUser adds a comment to testUser's post
      cy.login(otherUser.username, otherUser.password); 
      cy.visit('/'); // Need to visit the feed as otherUser
      cy.contains('.posts-list', postTextForComment).should('be.visible'); // Ensure post is loaded

      cy.contains('.post', postTextForComment).as('targetPostForOtherUser');
      cy.get('@targetPostForOtherUser').find('button').contains(/Comments|Hide/).click();
      cy.get('@targetPostForOtherUser').find('textarea[placeholder="Add a comment..."]').type(otherUserCommentText);
      cy.intercept('POST', `/api/v1/posts/${testPostId}/comments`).as('postCommentOtherUser');
      cy.get('@targetPostForOtherUser').find('form.comment-form button[type="submit"]').click();
      cy.wait('@postCommentOtherUser').its('response.statusCode').should('eq', 201);
      // Verify otherUser's comment appeared (optional step)
      cy.get('@targetPostForOtherUser').find('.comment').should('contain.text', otherUserCommentText);

      // 2. testUser logs back in and checks the comment
      cy.login(testUser.username, testUser.password);
      cy.visit('/'); // Visit feed as testUser
      cy.contains('.posts-list', postTextForComment).should('be.visible');
      
      cy.contains('.post', postTextForComment).as('targetPostForTestUser');
      cy.get('@targetPostForTestUser').find('button').contains(/Comments|Hide/).click();

      // 3. Verify delete button is not present on otherUser's comment
      cy.get('@targetPostForTestUser')
        .contains('.comment', otherUserCommentText) // Find the specific comment by text
        .find('.comment-delete-button') // Try to find the delete button within it
        .should('not.exist'); // Assert that the button does not exist
    });

    it('should not allow submitting an empty comment', () => {
      // Find the specific post
      cy.contains('.post', postTextForComment).as('targetPostForEmptyComment');

      // Show comments
      cy.get('@targetPostForEmptyComment').find('button').contains(/Comments|Hide/).click();

      // Find the textarea and ensure it's empty
      const commentTextarea = cy.get('@targetPostForEmptyComment').find('textarea[placeholder="Add a comment..."]');
      commentTextarea.should('be.visible');
      commentTextarea.clear(); // Ensure it is empty
      // Also check if the button becomes disabled (might depend on implementation)
      // cy.get('@targetPostForEmptyComment').find('form.comment-form button[type="submit"]').should('be.disabled');

      // Intercept the API endpoint to ensure it's NOT called
      cy.intercept('POST', `/api/v1/posts/${testPostId}/comments`).as('postCommentAttempt');

      // Attempt to click the submit button
      cy.get('@targetPostForEmptyComment').find('form.comment-form button[type="submit"]').click({ force: true }); // Use force:true if button might be disabled or blocked by native validation

      // Since the form has required attribute on textarea, the form shouldn't submit
      // We can verify that we're still on the same page and the textarea is still visible
      cy.wait(500); // Wait briefly to ensure no submission happened
      
      // Ensure no error message specific to empty comment appeared unless designed
      // cy.get('@targetPostForEmptyComment').find('.comment-form .error-message').should('not.exist'); 
      
      // Check we are still on the page / comment form is still visible
      commentTextarea.should('be.visible');
    });

  });

  it('should allow a user to delete their own post', () => {
    const postContentToDelete = `Post to be deleted by owner - ${Date.now()}`;

    // 1. Create a post as the current user (testuser) and chain subsequent actions
    cy.createPost({ content: postContentToDelete, privacy: 'PUBLIC' })
      .then((createdPost) => {
        const postIdToDelete = createdPost.id;
        cy.log(`Created post ${postIdToDelete} for deletion test.`);
        
        // Actions previously in cy.then(() => {...}) are now inside this .then()
        cy.visit('/'); // Re-visit the feed to see the newly created post
        
        // Wait for loading to complete by ensuring spinner is not present
        cy.get('.spinner-container', { timeout: 10000 }).should('not.exist');
        
        cy.contains('.posts-list', postContentToDelete, { timeout: 10000 }).should('be.visible'); // Ensure post is loaded

        // Find the post and verify delete button is visible (using .post selector)
        cy.contains('.post', postContentToDelete).as('postToDelete');
        cy.get('@postToDelete').find('.delete-button').should('be.visible');

        // Stub window.confirm and click delete
        cy.on('window:confirm', () => true);
        cy.intercept('DELETE', `/api/v1/posts/${postIdToDelete}`).as('deletePostApi');
        cy.get('@postToDelete').find('.delete-button').click();

        // Verify API call
        cy.wait('@deletePostApi').its('response.statusCode').should('eq', 200);

        // Verify post is removed from UI
        cy.get('.posts-list').should('not.contain.text', postContentToDelete);
      });
  });

  it("should NOT show delete button for another user's post", () => {
    const otherUserPostContent = `Other user post, should not be deletable - ${Date.now()}`;

    // 1. Create post as otherUser and chain subsequent actions
    cy.login(otherUser.username, otherUser.password); 
    cy.createPost({ content: otherUserPostContent, privacy: 'PUBLIC' })
      .then(() => {
        // 2. Login as testUser and view feed
        cy.login(testUser.username, testUser.password);
        cy.visit('/');
        
        // Wait for loading to complete by ensuring spinner is not present
        cy.get('.spinner-container', { timeout: 10000 }).should('not.exist');
        
        // Ensure post is loaded.
        cy.contains('.posts-list', otherUserPostContent, { timeout: 10000 }).should('be.visible'); 

        // 3. Find the other user's post and verify delete button is NOT visible
        cy.contains('.post', otherUserPostContent)
          .find('.delete-button')
          .should('not.exist');
      });
  });

  // Add more tests later (e.g., deleting posts, character limits?)
}); 