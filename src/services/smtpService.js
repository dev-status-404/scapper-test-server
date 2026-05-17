import nodemailer from "nodemailer";
import UserSmtpAccount from "../models/userSmtpAccount.model.js";

const createSmtpAccount = async (payload = {}, userId) => {
  if (!userId) {
    return { code: 400, success: false, message: "User ID is required" };
  }

  const requiredFields = [
    "email_address",
    "username",
    "smtp.host",
    "smtp.port",
    "password",
  ];

  for (const field of requiredFields) {
    const keys = field.split(".");
    let value = payload;
    for (const key of keys) {
      value = value?.[key];
    }
    if (value === undefined || value === null || value === "") {
      return {
        code: 400,
        success: false,
        message: `${field.replace("smtp.", "SMTP ")} is required`,
      };
    }
  }

  const account = new UserSmtpAccount({
    user_id: userId,
    label: payload.label,
    sender_name: payload.sender_name || payload.label || null,
    email_address: payload.email_address,
    username: payload.username,
    smtp: {
      host: payload.smtp.host,
      port: payload.smtp.port,
      secure: payload.smtp.secure !== undefined ? payload.smtp.secure : true,
    },
    imap: {
      enabled: Boolean(payload.settings?.enable_inbox || payload.imap?.enabled),
      host: payload.imap?.host || null,
      port: payload.imap?.port || null,
      secure: payload.imap?.secure !== undefined ? payload.imap?.secure : true,
    },
    settings: {
      enable_inbox: Boolean(payload.settings?.enable_inbox),
      warmup_enabled: Boolean(payload.settings?.warmup_enabled),
      messages_per_day:
        typeof payload.settings?.messages_per_day === "number"
          ? payload.settings.messages_per_day
          : 25,
      signature: payload.settings?.signature || null,
      unsubscribe_url: payload.settings?.unsubscribe_url || null,
      is_default: Boolean(payload.settings?.is_default),
      active: payload.settings?.active !== undefined ? payload.settings?.active : true,
    },
  });

  account.setPassword(payload.password);

  await account.save();

  return {
    code: 201,
    success: true,
    message: "SMTP account created successfully",
    data: account,
  };
};

const getSmtpAccounts = async (userId) => {
  if (!userId) {
    return { code: 400, success: false, message: "User ID is required" };
  }

  const accounts = await UserSmtpAccount.find({ user_id: userId }).sort({ createdAt: -1 });
  return {
    code: 200,
    success: true,
    message: "SMTP accounts retrieved successfully",
    data: accounts,
  };
};

const getSmtpAccountById = async (accountId, userId) => {
  if (!accountId) {
    return { code: 400, success: false, message: "Account ID is required" };
  }

  const account = await UserSmtpAccount.findOne({ _id: accountId, user_id: userId });
  if (!account) {
    return { code: 404, success: false, message: "SMTP account not found" };
  }

  return {
    code: 200,
    success: true,
    message: "SMTP account retrieved successfully",
    data: account,
  };
};

const updateSmtpAccount = async (accountId, payload = {}, userId) => {
  if (!accountId) {
    return { code: 400, success: false, message: "Account ID is required" };
  }

  const account = await UserSmtpAccount.findOne({ _id: accountId, user_id: userId });
  if (!account) {
    return { code: 404, success: false, message: "SMTP account not found" };
  }

  if (payload.label !== undefined) account.label = payload.label;
  if (payload.sender_name !== undefined) account.sender_name = payload.sender_name;
  if (payload.email_address !== undefined) account.email_address = payload.email_address;
  if (payload.username !== undefined) account.username = payload.username;

  if (payload.smtp) {
    if (payload.smtp.host !== undefined) account.smtp.host = payload.smtp.host;
    if (payload.smtp.port !== undefined) account.smtp.port = payload.smtp.port;
    if (payload.smtp.secure !== undefined) account.smtp.secure = payload.smtp.secure;
  }

  if (payload.imap) {
    if (payload.imap.enabled !== undefined) account.imap.enabled = payload.imap.enabled;
    if (payload.imap.host !== undefined) account.imap.host = payload.imap.host;
    if (payload.imap.port !== undefined) account.imap.port = payload.imap.port;
    if (payload.imap.secure !== undefined) account.imap.secure = payload.imap.secure;
  }

  if (payload.settings) {
    if (payload.settings.enable_inbox !== undefined)
      account.settings.enable_inbox = payload.settings.enable_inbox;
    if (payload.settings.warmup_enabled !== undefined)
      account.settings.warmup_enabled = payload.settings.warmup_enabled;
    if (payload.settings.messages_per_day !== undefined)
      account.settings.messages_per_day = payload.settings.messages_per_day;
    if (payload.settings.signature !== undefined)
      account.settings.signature = payload.settings.signature;
    if (payload.settings.unsubscribe_url !== undefined)
      account.settings.unsubscribe_url = payload.settings.unsubscribe_url;
    if (payload.settings.is_default !== undefined)
      account.settings.is_default = payload.settings.is_default;
    if (payload.settings.active !== undefined)
      account.settings.active = payload.settings.active;
  }

  if (payload.password) {
    account.setPassword(payload.password);
  }

  await account.save();

  return {
    code: 200,
    success: true,
    message: "SMTP account updated successfully",
    data: account,
  };
};

const deleteSmtpAccount = async (accountId, userId) => {
  if (!accountId) {
    return { code: 400, success: false, message: "Account ID is required" };
  }

  const account = await UserSmtpAccount.findOneAndDelete({ _id: accountId, user_id: userId });
  if (!account) {
    return { code: 404, success: false, message: "SMTP account not found" };
  }

  return {
    code: 200,
    success: true,
    message: "SMTP account deleted successfully",
    data: account,
  };
};

const createTransporterFromAccount = (account) => {
  const transportConfig = account.getTransportConfig();
  if (!transportConfig) {
    throw new Error("Unable to build SMTP transporter from account credentials");
  }
  return nodemailer.createTransport(transportConfig);
};

const sendEmailWithAccount = async (account, message) => {
  if (!account.settings.active) {
    return {
      code: 400,
      success: false,
      message: "SMTP account is not active",
    };
  }

  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);

  if (!account.day_window_start || account.day_window_start < midnight) {
    account.messages_sent_today = 0;
    account.day_window_start = now;
  }

  if (account.settings.messages_per_day > 0 && account.messages_sent_today >= account.settings.messages_per_day) {
    return {
      code: 429,
      success: false,
      message: "Daily message limit reached for this SMTP account",
    };
  }

  const transporter = createTransporterFromAccount(account);

  await transporter.verify();

  const mailOptions = {
    from: account.sender_name
      ? `"${account.sender_name}" <${account.email_address}>`
      : account.email_address,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  };

  await transporter.sendMail(mailOptions);

  account.messages_sent_today += 1;
  account.is_tested = true;
  account.status = "active";
  account.last_sent_at = now;
  await account.save();

  return {
    code: 200,
    success: true,
    message: "Email sent successfully",
    data: { to: message.to, subject: message.subject },
  };
};

const testSmtpAccount = async (accountId, userId, testEmail) => {
  if (!accountId) {
    return { code: 400, success: false, message: "Account ID is required" };
  }

  const account = await UserSmtpAccount.findOne({ _id: accountId, user_id: userId });
  if (!account) {
    return { code: 404, success: false, message: "SMTP account not found" };
  }

  const recipient = testEmail || account.email_address;

  try {
    return await sendEmailWithAccount(account, {
      to: recipient,
      subject: "SMTP account connection test",
      text: "This is a test email to verify your SMTP configuration.",
      html: `<p>This is a test email to verify your SMTP configuration.</p>`,
    });
  } catch (error) {
    account.status = "error";
    await account.save();
    return {
      code: 500,
      success: false,
      message: error.message || "SMTP test failed",
      error: error.toString(),
    };
  }
};

export const smtpService = {
  createSmtpAccount,
  getSmtpAccounts,
  getSmtpAccountById,
  updateSmtpAccount,
  deleteSmtpAccount,
  testSmtpAccount,
  sendEmailWithAccount,
};
