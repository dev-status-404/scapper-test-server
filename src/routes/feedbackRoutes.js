import express from 'express';
const router = express.Router();
import {feedbackController} from '../controllers/feedbackController.js';

// Folder routes
router.post('/create', feedbackController.createFeedback);
router.get('/get', feedbackController.getFeedback);
router.post('/update', feedbackController.updateFeedback);
router.delete('/delete', feedbackController.deleteFeedback);


export default router;