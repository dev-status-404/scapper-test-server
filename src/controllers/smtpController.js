import { smtpService } from "../services/smtpService.js";
import { safeError } from "../middlewares/error.js";

const createSmtpAccount = async (req, res) => {
  try {
    const response = await smtpService.createSmtpAccount(req.body, req.user._id);
    return res.status(response.code).json(response);
  } catch (error) {
    const payload = safeError(error);
    return res.status(payload.code).json(payload);
  }
};

const getSmtpAccounts = async (req, res) => {
  try {
    const response = await smtpService.getSmtpAccounts(req.user._id);
    return res.status(response.code).json(response);
  } catch (error) {
    const payload = safeError(error);
    return res.status(payload.code).json(payload);
  }
};

const getSmtpAccount = async (req, res) => {
  try {
    const response = await smtpService.getSmtpAccountById(req.params.id, req.user._id);
    return res.status(response.code).json(response);
  } catch (error) {
    const payload = safeError(error);
    return res.status(payload.code).json(payload);
  }
};

const updateSmtpAccount = async (req, res) => {
  try {
    const response = await smtpService.updateSmtpAccount(req.params.id, req.body, req.user._id);
    return res.status(response.code).json(response);
  } catch (error) {
    const payload = safeError(error);
    return res.status(payload.code).json(payload);
  }
};

const deleteSmtpAccount = async (req, res) => {
  try {
    const response = await smtpService.deleteSmtpAccount(req.params.id, req.user._id);
    return res.status(response.code).json(response);
  } catch (error) {
    const payload = safeError(error);
    return res.status(payload.code).json(payload);
  }
};

const testSmtpAccount = async (req, res) => {
  try {
    const response = await smtpService.testSmtpAccount(
      req.params.id,
      req.user._id,
      req.body.test_email,
    );
    return res.status(response.code).json(response);
  } catch (error) {
    const payload = safeError(error);
    return res.status(payload.code).json(payload);
  }
};

const sendEmail = async (req, res) => {
  try {
    const account = await smtpService.getSmtpAccountById(req.params.id, req.user._id);
    if (!account.success) {
      return res.status(account.code).json(account);
    }

    const response = await smtpService.sendEmailWithAccount(account.data, req.body);
    return res.status(response.code).json(response);
  } catch (error) {
    return safeError(res, error);
  }
};

export const smtpController = {
  createSmtpAccount,
  getSmtpAccounts,
  getSmtpAccount,
  updateSmtpAccount,
  deleteSmtpAccount,
  testSmtpAccount,
  sendEmail,
};
