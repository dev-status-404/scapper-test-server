import jwt from 'jsonwebtoken';
// import {
//   JWT_SECRET,
//   JWT_ACCESS_EXPIRATION_MINUTES,
//   JWT_REFRESH_EXPIRATION_DAYS,
//   JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
//   JWT_VERIFY_EMAIL_EXPIRATION_MINUTES,
// } from '../config/env.js';

/**
 * Generate token
 * @param {Object} payload - The payload to sign
 * @param {string} expiresIn - Expiration time (e.g., '1h', '7d')
 * @returns {string} - JWT token
 */
const generateToken = (payload, expiresIn) => {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
};

/**
 * Generate auth tokens
 * @param {Object} user - User object
 * @returns {Promise<Object>} - Access and refresh tokens
 */
const generateAuthTokens = (user) => {
  const accessTokenExpires = `${process.env.JWT_ACCESS_EXPIRATION_MINUTES}m`;
  const refreshTokenExpires = `${process.env.JWT_REFRESH_EXPIRATION_DAYS}d`;
  
  const accessToken = generateToken(
    { sub: user.id, role: user.role },
    accessTokenExpires
  );
  
  const refreshToken = generateToken(
    { sub: user.id, type: 'refresh' },
    refreshTokenExpires
  );
  
  return {
    access: {
      token: accessToken,
      expires: new Date(Date.now() + process.env.JWT_ACCESS_EXPIRATION_MINUTES * 60 * 1000),
    },
    refresh: {
      token: refreshToken,
      expires: new Date(Date.now() + process.env.JWT_REFRESH_EXPIRATION_DAYS * 24 * 60 * 60 * 1000),
    },
  };
};

/**
 * Generate reset password token
 * @returns {string} - Reset password token
 */
const generateResetPasswordToken = () => {
  const expiresIn = `${process.env.JWT_RESET_PASSWORD_EXPIRATION_MINUTES}m`;
  return generateToken({ type: 'resetPassword' }, expiresIn);
};

/**
 * Generate verify email token
 * @returns {string} - Verify email token
 */
const generateVerifyEmailToken = () => {
  const expiresIn = `${process.env.JWT_VERIFY_EMAIL_EXPIRATION_MINUTES}m`;
  return generateToken({ type: 'verifyEmail' }, expiresIn);
};

/**
 * Verify token
 * @param {string} token - JWT token to verify
 * @returns {Promise<Object>} - Decoded token
 */
const verifyToken = (token) => {
  return new Promise((resolve, reject) => {
    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        reject(new Error('Invalid token'));
      } else {
        resolve(decoded);
      }
    });
  });
};

export {
  generateToken,
  generateAuthTokens,
  generateResetPasswordToken,
  generateVerifyEmailToken,
  verifyToken,
};
