import express from 'express';
const router = express.Router();
import {folderController} from '../controllers/folderController.js';

// Folder routes
router.post('/create', folderController.createFolder);
router.get('/get', folderController.getFolder);
router.post('/update', folderController.updateFolder);
router.delete('/delete/:id', folderController.deleteFolder);
router.post('/bulk-delete', folderController.bulkDelete);


export default router;
