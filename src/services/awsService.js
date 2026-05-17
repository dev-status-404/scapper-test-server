import AWS from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import dotenv from "dotenv";

dotenv.config();

// AWS S3 Configuration using environment variables
const s3Config = {
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  bucket: process.env.AWS_S3_BUCKET,
  // cloudFrontUrl: process.env.AWS_CLOUDFRONT_URL || 'https://d3owfp13tbhhin.cloudfront.net'
};

// Initialize S3 instance
const s3 = new AWS.S3({
  region: s3Config.region,
  accessKeyId: s3Config.accessKeyId,
  secretAccessKey: s3Config.secretAccessKey
});

/**
 * Upload a file to AWS S3
 * @param {Object} file - The file object from multer
 * @param {String} folder - The folder to upload to in S3 (e.g., 'store/logos', 'store/sliders')
 * @returns {Promise<String>} - The URL of the uploaded file
 */
export const uploadFileToS3 = async (file, folder = '') => {
  try {
    if (!file) {
      throw new Error('No file provided');
    }

    // Generate a unique filename
    const fileExtension = path.extname(file.originalname);
    const fileName = `${folder}/${uuidv4()}${fileExtension}`;

    // Set up the S3 upload parameters
    const params = {
      Bucket: s3Config.bucket,
      Key: fileName,
      Body: fs.createReadStream(file.path),
      ContentType: file.mimetype,
      // ACL: 'public-read' // Make the file publicly accessible
    };

    // Upload the file to S3
    const uploadResult = await s3.upload(params).promise();

    // Clean up the temporary file
    fs.unlinkSync(file.path);

    // Return the CloudFront URL for the uploaded file
    return uploadResult.Location;
  } catch (error) {
    console.error('Error uploading file to S3:', error);
    throw error;
  }
};

/**
 * Upload multiple files to AWS S3
 * @param {Array} files - Array of file objects from multer
 * @param {String} folder - The folder to upload to in S3
 * @returns {Promise<Array<String>>} - Array of URLs of the uploaded files
 */
export const uploadMultipleFilesToS3 = async (files, folder = '') => {
  try {
    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new Error('No files provided');
    }

    // Upload each file and collect the URLs
    const uploadPromises = files.map(file => uploadFileToS3(file, folder));
    return await Promise.all(uploadPromises);
  } catch (error) {
    console.error('Error uploading multiple files to S3:', error);
    throw error;
  }
};

/**
 * Delete a file from AWS S3
 * @param {String} fileUrl - The URL of the file to delete
 * @returns {Promise<Boolean>} - True if deletion was successful
 */
export const deleteFileFromS3 = async (fileUrl) => {
  try {
    if (!fileUrl) {
      throw new Error('No file URL provided');
    }

    // Extract the key from the CloudFront URL
    const key = fileUrl.replace(`${s3Config.cloudFrontUrl}/`, '');

    // Set up the S3 delete parameters
    const params = {
      Bucket: s3Config.bucket,
      Key: key
    };

    // Delete the file from S3
    await s3.deleteObject(params).promise();
    return true;
  } catch (error) {
    console.error('Error deleting file from S3:', error);
    throw error;
  }
};

export const awsService = {
  uploadFileToS3,
  uploadMultipleFilesToS3,
  deleteFileFromS3
};
