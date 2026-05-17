import { validationResult } from 'express-validator';
import ApiError from '../utils/ApiError.js';
import httpStatus from 'http-status';

const validate = (validations) => {
  return async (req, res, next) => {
    await Promise.all(validations.map(validation => validation.run(req)));

    const errors = validationResult(req);
    if (errors.isEmpty()) {
      return next();
    }

    const extractedErrors = [];
    errors.array().map(err => extractedErrors.push({ [err.param]: err.msg }));

    next(new ApiError(
      httpStatus.BAD_REQUEST,
      'Validation Error',
      false,
      extractedErrors
    ));
  };
};

export default validate;
