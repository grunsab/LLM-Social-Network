import requests
import json
import uuid
import io
import base64
from datetime import datetime, timezone
from flask import current_app, jsonify, request
from flask_restful import Resource, reqparse, abort
from flask_login import current_user, login_required

from models import db, Post, User, PostCategoryScore, UserImageGenerationStats

# --- Parser for image remixing ---
image_remix_parser = reqparse.RequestParser()
image_remix_parser.add_argument('post_id', type=int, required=True, help='Post ID containing the image to remix')
image_remix_parser.add_argument(
    'prompt', 
    type=lambda x: x if len(x) <= 500 else abort(400, message="Prompt cannot exceed 500 characters."), 
    required=True, 
    help='Remix prompt for image transformation (max 500 characters)'
)

class ImageRemixResource(Resource):
    def _get_r2_file_url(self, app_config, s3_key):
        """Helper to generate R2/S3 file URL based on app configuration."""
        if not s3_key:
            return None

        s3_bucket = app_config.get('S3_BUCKET')
        domain_name_images = app_config.get('DOMAIN_NAME_IMAGES')
        s3_endpoint_url = app_config.get('S3_ENDPOINT_URL')

        file_url = None
        if s3_bucket:
            try:
                if domain_name_images:
                    file_url = f"{domain_name_images}/{s3_key}"
                elif s3_endpoint_url:
                    file_url = f"{s3_endpoint_url}/{s3_bucket}/{s3_key}"
            except Exception as e:
                current_app.logger.error(f"Error generating R2/S3 URL for key {s3_key}: {e}")
                return None
        return file_url

    def _download_image_to_base64(self, image_url):
        """Download image from URL and convert to base64."""
        try:
            response = requests.get(image_url, timeout=30)
            response.raise_for_status()
            
            # Convert to base64
            image_base64 = base64.b64encode(response.content).decode('utf-8')
            return image_base64
        except requests.exceptions.RequestException as e:
            current_app.logger.error(f"Error downloading image from {image_url}: {e}")
            return None
        except Exception as e:
            current_app.logger.error(f"Error converting image to base64: {e}")
            return None

    def _call_runware_api(self, image_url, prompt):
        """Call Runware API with Flux Kontext Dev for image remixing."""
        runware_api_key = current_app.config.get('RUNWARE_API_KEY')
        
        if not runware_api_key:
            current_app.logger.error("RUNWARE_API_KEY not configured")
            abort(500, message="Image remix service is not configured")
        
        # Download and convert the reference image to base64
        reference_image_base64 = self._download_image_to_base64(image_url)
        if not reference_image_base64:
            current_app.logger.error(f"Failed to download or convert reference image: {image_url}")
            abort(500, message="Failed to process reference image")
        
        headers = {
            'Authorization': f'Bearer {runware_api_key}',
            'Content-Type': 'application/json'
        }
        
        # Prepare the request payload for Runware API
        task_uuid = str(uuid.uuid4())  # Generate a unique task UUID
        payload = [{
            "taskType": "imageInference",
            "taskUUID": task_uuid,
            "prompt": prompt,
            "positivePrompt": prompt,
            "seedImage": reference_image_base64,
            "width": 1024,
            "height": 1024,
            "model": "runware:106@1",  # FLUX.1 Kontext [dev] model ID
            "numberResults": 1,
            "outputFormat": "JPEG",
            "outputType": "base64Data",
            "steps": 28,
            "guidanceScale": 7.5,
            "strength": 0.9,
        }]
        
        try:
            response = requests.post(
                'https://api.runware.ai/v1',
                headers=headers,
                json=payload,
                timeout=60
            )
            
            response.raise_for_status()
            result = response.json()
            
            current_app.logger.info(f"Runware API response: {result}")
            
            # Extract base64 image data from response
            # Runware API returns a dict with 'data' array containing task results
            if isinstance(result, dict) and 'data' in result:
                data_array = result['data']
                if isinstance(data_array, list) and len(data_array) > 0:
                    task_result = data_array[0]
                    if task_result.get('taskType') == 'imageInference':
                        image_data = task_result.get('imageBase64Data')
                        if image_data:
                            # Remove data URL prefix if present
                            if image_data.startswith('data:'):
                                image_data = image_data.split(',')[1]
                            return image_data
            
            current_app.logger.error(f"Unexpected Runware API response structure: {result}")
            return None
            
        except requests.exceptions.RequestException as e:
            current_app.logger.error(f"Runware API request error: {e}")
            if hasattr(e, 'response') and e.response is not None:
                try:
                    error_data = e.response.json()
                    current_app.logger.error(f"Runware API error response: {error_data}")
                except:
                    current_app.logger.error(f"Runware API error response text: {e.response.text}")
            return None
        except Exception as e:
            current_app.logger.error(f"Unexpected error calling Runware API: {e}")
            return None

    @login_required
    def post(self):
        args = image_remix_parser.parse_args()
        post_id = args['post_id']
        prompt = args['prompt']

        # Get the original post
        original_post = Post.query.get(post_id)
        if not original_post:
            abort(404, message="Post not found")
        
        # Check if the post has an image
        if not original_post.image_url:
            abort(400, message="This post does not contain an image to remix")
        
        # Check if the user can access this post (public or from a friend)
        from models import PostPrivacy, FriendRequestStatus
        if original_post.privacy != PostPrivacy.PUBLIC:
            # Check if the user is friends with the post author
            is_friend = False
            if current_user.id != original_post.user_id:
                from models import FriendRequest
                is_friend = FriendRequest.query.filter(
                    ((FriendRequest.sender_id == current_user.id) & 
                     (FriendRequest.receiver_id == original_post.user_id)) |
                    ((FriendRequest.sender_id == original_post.user_id) & 
                     (FriendRequest.receiver_id == current_user.id)),
                    FriendRequest.status == FriendRequestStatus.ACCEPTED
                ).first() is not None
                
                if not is_friend:
                    abort(403, message="You don't have permission to remix this image")

        # Rate limiting check
        today = datetime.now(timezone.utc).date()
        stats = UserImageGenerationStats.query.filter_by(user_id=current_user.id, generation_date=today).first()

        if stats and stats.count >= 20:
            abort(429, message="You have reached your daily limit of 20 image generations/remixes.")

        s3_client = current_app.config.get('S3_CLIENT')
        s3_bucket = current_app.config.get('S3_BUCKET')
        if not s3_client or not s3_bucket:
            abort(500, message="S3/R2 storage is not configured.")

        try:
            # 1. Call Runware API to remix the image
            current_app.logger.info(f"Calling Runware API to remix image from post {post_id}")
            image_b64 = self._call_runware_api(original_post.image_url, prompt)
            
            if not image_b64:
                abort(500, message="Failed to generate remixed image from Runware API")

            # 2. Decode the base64 image data
            image_data_bytes = base64.b64decode(image_b64)
            image_data = io.BytesIO(image_data_bytes)

            if image_data.getbuffer().nbytes == 0:
                abort(500, message="Decoded image data is empty.")

            content_type = 'image/jpeg'
            extension = '.jpg'

            # 3. Upload to R2
            s3_filename = f"remixed_images/{current_user.id}/{uuid.uuid4()}{extension}"
            
            image_data.seek(0) 

            s3_client.upload_fileobj(
                image_data,
                s3_bucket,
                s3_filename,
                ExtraArgs={'ContentType': content_type}
            )
            
            # 4. Get the R2 public URL
            final_image_url = self._get_r2_file_url(current_app.config, s3_filename)
            if not final_image_url:
                try:
                    s3_client.delete_object(Bucket=s3_bucket, Key=s3_filename)
                    current_app.logger.info(f"Cleaned up S3 object {s3_filename} after URL generation failure.")
                except Exception as s3_del_e:
                    current_app.logger.error(f"Failed to cleanup S3 object {s3_filename}: {s3_del_e}")
                abort(500, message="Failed to construct final image URL after uploading to R2.")

            # 5. Classify the remixed image using Gemma
            gemma_classifier = current_app.config.get('GEMMA_CLASSIFIER')
            image_classification_scores = {}
            if gemma_classifier:
                try:
                    image_classification_scores = gemma_classifier.classify_image(image_data_bytes)
                    current_app.logger.info(f"Image classification successful for remixed image: {image_classification_scores}")
                except Exception as e:
                    current_app.logger.error(f"Error during image classification for remixed image: {e}")
            else:
                current_app.logger.warning("Gemma classifier not found in app config. Skipping image classification.")

            # 6. Create a new post with the remixed image and attribution
            original_author = User.query.get(original_post.user_id)
            attribution_text = f"Remixed from @{original_author.username}'s post with prompt: {prompt}"
            
            new_post = Post(
                content=attribution_text,
                user_id=current_user.id,
                image_url=final_image_url,
                classification_scores=image_classification_scores,
                parent_post_id=original_post.id  # Link to original post
            )
            db.session.add(new_post)
            db.session.flush()

            # 7. Populate PostCategoryScore from classification results
            if image_classification_scores:
                for category, score in image_classification_scores.items():
                    if isinstance(score, (float, int)) and score > 0:
                        post_category_score = PostCategoryScore(
                            post_id=new_post.id,
                            category=category,
                            score=float(score)
                        )
                        db.session.add(post_category_score)
            
            # Update generation stats
            if stats:
                stats.count += 1
            else:
                stats = UserImageGenerationStats(user_id=current_user.id, generation_date=today, count=1)
                db.session.add(stats)
            
            db.session.commit()

            return {
                'message': 'Image remixed successfully',
                'post_id': new_post.id,
                'image_url': final_image_url,
                'classification': image_classification_scores,
                'original_post_id': original_post.id
            }, 201

        except Exception as e:
            current_app.logger.error(f"An unexpected error occurred during image remixing: {e}", exc_info=True)
            abort(500, message="An unexpected error occurred during image remixing.")