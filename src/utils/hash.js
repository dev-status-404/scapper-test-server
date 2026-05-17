import bcrypt from 'bcryptjs';

/**
 * Hash a password
 * @param {string} password - The password to hash
 * @returns {Promise<string>} - The hashed password
 */
const hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

/**
 * Compare a password with a hash
 * @param {string} password - The password to compare
 * @param {string} hash - The hash to compare against
 * @returns {Promise<boolean>} - True if the password matches the hash, false otherwise
 */
const comparePassword = async (password, hash) => {
  return bcrypt.compare(password, hash);
};

export { hashPassword, comparePassword };
