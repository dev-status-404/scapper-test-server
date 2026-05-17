import express from 'express';
const router = express.Router();
import { emailController } from '../controllers/emailController.js';

// Email routes
router.post('/add', emailController.addEmail);
router.post('/verify', emailController.verifyEmail);
router.get('/get', emailController.getEmail);
router.delete('/delete', emailController.deleteEmail);
router.post('/bulk-delete', emailController.bulkDeleteEmail);

export default router;