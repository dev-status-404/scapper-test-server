import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Create uploads directory if it doesn't exist
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

// File filter to accept only images
const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/jpg'];
  
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WEBP images are allowed.'), false);
  }
};

// Create multer upload instance
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Middleware for handling file upload errors
const handleFileUploadErrors = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    // A Multer error occurred when uploading
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 5MB.'
      });
    }
    return res.status(400).json({
      success: false,
      message: `Multer error: ${err.message}`
    });
  } else if (err) {
    // An unknown error occurred
    return res.status(400).json({
      success: false,
      message: err.message
    });
  }
  next();
};

// Export middleware functions for different upload scenarios
export const uploadStoreLogo = upload.single('logo');
export const uploadImage = upload.single('image');
export const uploadAvatarImage = upload.single('file');
export const uploadStoreSliders = upload.array('sliderImages', 10); // Max 10 slider images
export const uploadProductImages = upload.array('images', 10); // Max 10 product images

// Combined middleware for store creation with all possible file uploads
export const uploadStoreFiles = (req, res, next) => {
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'cover', maxCount: 1 },
    { name: 'sliderImages', maxCount: 10 }
  ])(req, res, (err) => {
    if (err) {
      return handleFileUploadErrors(err, req, res, next);
    }
    
    // Process the uploaded files and attach them to the request body
    if (req.files) {
      // Handle logo
      if (req.files.logo && req.files.logo.length > 0) {
        req.body.logo = req.files.logo[0];
      }
      
      // Handle cover
      if (req.files.cover && req.files.cover.length > 0) {
        req.body.cover = req.files.cover[0];
      }
      
      // Handle slider images
      if (req.files.sliderImages && req.files.sliderImages.length > 0) {
        req.body.sliderImages = req.files.sliderImages;
      }
    }
    
    next();
  });
};

// Combined middleware for product creation with all possible file uploads
export const uploadProductFiles = (req, res, next) => {
  upload.array('images', 10)(req, res, (err) => {
    if (err) {
      return handleFileUploadErrors(err, req, res, next);
    }
    
    // Process the uploaded files and attach them to the request body
    if (req.files && req.files.length > 0) {
      req.body.images = req.files;
    }
    
    next();
  });
};

export default {
  uploadStoreLogo,
  uploadImage,
  uploadAvatarImage,
  uploadStoreSliders,
  uploadProductImages,
  uploadStoreFiles,
  uploadProductFiles,
  handleFileUploadErrors
};
