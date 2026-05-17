import express from 'express';
const router = express.Router();
import {bugController} from '../controllers/bugController.js';

// Folder routes
router.post('/create', bugController.createBug);
router.get('/get', bugController.getBug);
router.post('/update', bugController.updateBug);
router.delete('/delete/:id', bugController.deleteBug);


export default router;