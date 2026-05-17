import nodemailer from "nodemailer";
import logger from "./logger.js";
import dotenv from "dotenv";
import config from "../config/env.js";
import { v4 as uuidv4 } from "uuid";

dotenv.config();
 const { email } = config;
const port = Number(email.smtp.port);
const isImplicitTLS = port === 465;

// Create a SMTP transporter
const transporter = nodemailer.createTransport({
  host: email.smtp.host,
  port: port,
  secure: false, // true for 587, false for other ports
  auth: {
    user: email.smtp.auth.user,
    pass: email.smtp.auth.pass,
  },
  requireTLS: !isImplicitTLS, // ✅ on 587 enforce STARTTLS
  tls: { minVersion: "TLSv1.2" }, // modern TLS only
  pool: true,
  maxConnections: 3,
  maxMessages: 100,
  logger: true, // nodemailer logs SMTP convo
  debug: true,
});

// Verify connection configuration
transporter.verify((error) => {
  if (error) {
    logger.error("Error with mail configuration:", error);
  } else {
    logger.info("Server is ready to take our messages");
  }
});

/**
 * Send an email
 * @param {string} to - Recipient email address
 * @param {string} subject - Email subject
 * @param {string} text - Plain text body
 * @param {string} html - HTML body
 * @returns {Promise}
 */
const sendEmail = async (to, subject, text, html, from) => {
  const msg = {
    from: from || `${email.from} <${email.from}>`,
    to,
    subject,
    text,
    html,
  };

  try {
    await transporter.sendMail(msg);
    logger.info(`Email sent to ${to}`);
  } catch (error) {
    logger.error("Error sending email:", error);
    throw new Error("Failed to send email");
  }
};

/**
 * Send verification email
 * @param {string} to - Recipient email address
 * @param {string} token - Verification token
 * @returns {Promise}
 */
const sendVerificationEmail = async (to, otp) => {
  const subject = "Email Verification - Your OTP Code";
  const text = `Your verification code is: ${otp}\n\nThis code will expire in 10 minutes.`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #f8f9fa; padding: 20px; border-radius: 5px;">
        <h2 style="color: #2c3e50; margin-bottom: 20px;">Verify Your Email</h2>
        <p>Thank you for registering! Please use the following OTP (One-Time Password) to verify your email address:</p>
        
        <div style="background-color: #ffffff; border: 1px solid #dee2e6; border-radius: 5px; padding: 15px; text-align: center; margin: 20px 0;">
          <span style="font-size: 24px; font-weight: bold; letter-spacing: 5px; color: #2c3e50;">${otp}</span>
        </div>
        
        <p style="color: #6c757d; font-size: 14px;">
          This OTP will expire in 10 minutes. Please do not share this code with anyone.
        </p>
        
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #dee2e6; font-size: 12px; color: #6c757d;">
          <p>If you didn't request this email, you can safely ignore it.</p>
        </div>
      </div>
    </div>
  `;

  await sendEmail(to, subject, text, html);
};

/**
 * Send password reset email
 * @param {string} to - Recipient email address
 * @param {string} token - Reset token
 * @returns {Promise}
 */
// const sendPasswordResetEmail = async (to, token) => {
//   const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
//   const subject = 'Password Reset Request';
//   const text = `To reset your password, click: ${resetUrl}`;
//   const html = `
//     <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
//       <h2>Reset Your Password</h2>
//       <p>You requested to reset your password. Click the button below to reset it:</p>
//       <a href="${resetUrl}"
//          style="display: inline-block; padding: 10px 20px; background-color: #2196F3; color: white; text-decoration: none; border-radius: 5px; margin: 10px 0;">
//         Reset Password
//       </a>
//       <p>Or copy and paste this link into your browser:</p>
//       <p>${resetUrl}</p>
//       <p>This link will expire in 10 minutes.</p>
//       <p>If you didn't request this, please ignore this email.</p>
//     </div>
//   `;

//   await sendEmail(to, subject, text, html);
// };

// In src/utils/email.js
// ... existing code ...

const sendPasswordResetEmail = async (email, otp) => {
  const subject = "Password Reset OTP";
  const text = `Your password reset OTP is: ${otp}\nThis OTP will expire in 10 minutes.`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Password Reset Request</h2>
      <p>You have requested to reset your password. Use the following OTP to proceed:</p>
      <div style="background: #f4f4f4; padding: 20px; text-align: center; margin: 20px 0;">
        <h1 style="margin: 0; font-size: 28px; letter-spacing: 5px;">${otp}</h1>
      </div>
      <p>This OTP will expire in 10 minutes.</p>
      <p>If you didn't request this, please ignore this email.</p>
    </div>
  `;

  await sendEmail(email, subject, text, html);
};

const sendResendOTPEmail = async (to, otp) => {
  const subject = "New Verification Code - Your OTP";
  const text = `Your new verification code is: ${otp}\n\nThis code will expire in 10 minutes.`;
  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #f8f9fa; padding: 20px; border-radius: 5px;">
        <h2 style="color: #2c3e50; margin-bottom: 20px;">New Verification Code</h2>
        <p>You have requested a new verification code. Here's your new OTP (One-Time Password):</p>
        
        <div style="background-color: #ffffff; border: 1px solid #dee2e6; border-radius: 5px; padding: 15px; text-align: center; margin: 20px 0;">
          <span style="font-size: 24px; font-weight: bold; letter-spacing: 5px; color: #2c3e50;">${otp}</span>
        </div>
        
        <p style="color: #6c757d; font-size: 14px;">
          This OTP will expire in 10 minutes. Please do not share this code with anyone.
        </p>
        
        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #dee2e6; font-size: 12px; color: #6c757d;">
          <p>If you didn't request this code, please secure your account immediately.</p>
        </div>
      </div>
    </div>
  `;

  await sendEmail(to, subject, text, html);
};

// Predefined email campaign templates
const campaignTemplates = {
  welcome: {
    html: (leadName, campaignName) => `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to ${campaignName}</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #4a90e2; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #f9f9f9; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
          .button { display: inline-block; padding: 12px 24px; background: #4a90e2; color: white; text-decoration: none; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome ${leadName}!</h1>
          </div>
          <div class="content">
            <p>We're excited to have you join ${campaignName}!</p>
            <p>Thank you for signing up. We're thrilled to have you on board and can't wait to show you what we have to offer.</p>
            <p>If you have any questions, feel free to reach out to our support team.</p>
            <p><a href="#" class="button">Get Started</a></p>
          </div>
          <div class="footer">
            <p>&copy; 2026 ${campaignName}. All rights reserved.</p>
            <p>If you didn't sign up for this, please ignore this email.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: (leadName, campaignName) => `
      Welcome ${leadName}!
      
      We're excited to have you join ${campaignName}!
      
      Thank you for signing up. We're thrilled to have you on board and can't wait to show you what we have to offer.
      
      If you have any questions, feel free to reach out to our support team.
      
      Get Started: [Your Website URL]
      
      © 2026 ${campaignName}. All rights reserved.
      If you didn't sign up for this, please ignore this email.
    `,
  },
  newsletter: {
    html: (leadName, campaignName, content) => `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${campaignName} Newsletter</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2c3e50; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #ffffff; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; background: #f4f4f4; }
          .article { margin-bottom: 20px; padding-bottom: 20px; border-bottom: 1px solid #eee; }
          .article:last-child { border-bottom: none; }
          .button { display: inline-block; padding: 10px 20px; background: #3498db; color: white; text-decoration: none; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>${campaignName} Newsletter</h1>
            <p>Hi ${leadName}, here's what's new this month!</p>
          </div>
          <div class="content">
            ${content}
          </div>
          <div class="footer">
            <p>&copy; 2026 ${campaignName}. All rights reserved.</p>
            <p><a href="#">Unsubscribe</a> | <a href="#">Manage Preferences</a></p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: (leadName, campaignName, content) => `
      ${campaignName} Newsletter
      
      Hi ${leadName}, here's what's new this month!
      
      ${content}
      
      © 2026 ${campaignName}. All rights reserved.
      Unsubscribe | Manage Preferences
    `,
  },
  promotional: {
    html: (leadName, campaignName, offer, discount) => `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Special Offer from ${campaignName}</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #e74c3c; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background: #fff; text-align: center; }
          .offer { background: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px; }
          .discount { font-size: 36px; font-weight: bold; color: #e74c3c; }
          .footer { padding: 20px; text-align: center; font-size: 12px; color: #666; }
          .button { display: inline-block; padding: 15px 30px; background: #e74c3c; color: white; text-decoration: none; border-radius: 4px; font-size: 18px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Exclusive Offer for ${leadName}!</h1>
          </div>
          <div class="content">
            <div class="offer">
              <h2>${offer}</h2>
              <div class="discount">${discount}</div>
              <p>Limited time only - Don't miss out!</p>
            </div>
            <p><a href="#" class="button">Claim Your Offer</a></p>
          </div>
          <div class="footer">
            <p>&copy; 2026 ${campaignName}. All rights reserved.</p>
            <p>Offer expires soon. Terms and conditions apply.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: (leadName, campaignName, offer, discount) => `
      Exclusive Offer for ${leadName}!
      
      ${offer}
      
      ${discount}
      
      Limited time only - Don't miss out!
      
      Claim Your Offer: [Your Website URL]
      
      © 2026 ${campaignName}. All rights reserved.
      Offer expires soon. Terms and conditions apply.
    `,
  },
};

const TRACKING_PIXEL_MARKER = "<!--TRACKING_PIXEL-->";

const PLACEHOLDER_HOSTS = ["yourapi.com", "yourdomain.com", "example.com"];

const isUsableTrackingBaseUrl = (url) => {
  if (!url) return false;

  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    if (!parsed.protocol.startsWith("http")) return false;
    if (PLACEHOLDER_HOSTS.some((ph) => host === ph || host.endsWith(`.${ph}`))) return false;
    if (host.includes("app.dataharvx.com")) return false;
    return true;
  } catch {
    return false;
  }
};

const getTrackingBaseUrl = () =>
  ([
    process.env.API_BASE_URL,
    process.env.APP_URL,
    process.env.BASE_URL,
  ].find(isUsableTrackingBaseUrl) || "https://api.dataharvx.com")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");

const shouldTrackHref = (url) => {
  const normalized = (url || "").trim().toLowerCase();
  return (
    normalized &&
    !normalized.startsWith("#") &&
    !normalized.startsWith("mailto:") &&
    !normalized.startsWith("tel:") &&
    !normalized.startsWith("javascript:") &&
    !normalized.includes("/api/campaign/track/")
  );
};

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const extractBodyContent = (html = "") => {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return bodyMatch[1];

  return html
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(/<\/?html[^>]*>/gi, "")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, "");
};

const wrapEmailHtml = (html = "", { subject = "" } = {}) => {
  const content = extractBodyContent(html).replaceAll(TRACKING_PIXEL_MARKER, "");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f6f8;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px;font-size:1px;">${escapeHtml(subject)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f6f8;margin:0;padding:24px 0;">
      <tr>
        <td align="center" style="padding:0 12px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:28px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55;color:#111827;">
                ${content}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
    ${TRACKING_PIXEL_MARKER}
  </body>
</html>`;
};

const normalizeButtonLinks = (html = "") => {
  return html.replace(
    /<button\b([^>]*)>([\s\S]*?)<\/button>/gi,
    (match, attrs, label) => {
      const hrefMatch = attrs.match(/\s(?:href|data-href|data-url)=["']([^"']+)["']/i);
      if (!hrefMatch || !shouldTrackHref(hrefMatch[1])) return match;

      return `<a href="${hrefMatch[1]}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#1677ff;color:#ffffff;text-decoration:none;font-family:Arial,Helvetica,sans-serif;">${label}</a>`;
    },
  );
};

const sendCampaignEmail = async (campaignData) => {
  try {
    const {
      to,
      subject,
      templateType,
      templateData = {},
      htmlContent,
      textContent,
      campaignId,
      leadId,
      trackingId,
    } = campaignData;
    let finalHtml;
    let finalText;
    const emailTrackingId = trackingId || uuidv4();

    if (typeof htmlContent === "string" && htmlContent.trim()) {
      finalHtml = htmlContent;
      finalText =
        typeof textContent === "string" && textContent.trim()
          ? textContent
          : htmlContent.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    } else {
      // Get the template based on type
      const template = campaignTemplates[templateType];
      if (!template) {
        throw new Error(`Template type '${templateType}' not found`);
      }

      // Generate HTML and text content using template
      const leadName = templateData.leadName || "Valued Customer";
      const campaignName = templateData.campaignName || "Our Service";

      switch (templateType) {
        case "welcome":
          finalHtml = template.html(leadName, campaignName);
          finalText = template.text(leadName, campaignName);
          break;
        case "newsletter":
          finalHtml = template.html(
            leadName,
            campaignName,
            templateData.content || "",
          );
          finalText = template.text(
            leadName,
            campaignName,
            templateData.content || "",
          );
          break;
        case "promotional":
          finalHtml = template.html(
            leadName,
            campaignName,
            templateData.offer || "",
            templateData.discount || "",
          );
          finalText = template.text(
            leadName,
            campaignName,
            templateData.offer || "",
            templateData.discount || "",
          );
          break;
        default:
          finalHtml = template.html(leadName, campaignName, templateData);
          finalText = template.text(leadName, campaignName, templateData);
      }
    }

    // Ensure tracking pixel marker is present before wrapping
    if (typeof finalHtml === "string") {
      if (!finalHtml.includes(TRACKING_PIXEL_MARKER) && !finalHtml.includes("/api/campaign/track/")) {
        if (/<\/body>/i.test(finalHtml)) {
          finalHtml = finalHtml.replace(/<\/body>/i, `${TRACKING_PIXEL_MARKER}</body>`);
        } else {
          finalHtml = `${finalHtml}${TRACKING_PIXEL_MARKER}`;
        }
      }
    }
    finalHtml = wrapEmailHtml(finalHtml, { subject });

    if (campaignId && leadId) {
      const trackingBaseUrl = getTrackingBaseUrl();
      // Append ngrok bypass so Gmail's Google Image Proxy (no session cookie)
      // receives the GIF rather than the ngrok interstitial HTML page.
      const withBypass = (url) => {
        if (!url || !url.toLowerCase().includes("ngrok")) return url;
        try {
          const u = new URL(url);
          u.searchParams.set("ngrok-skip-browser-warning", "1");
          return u.toString();
        } catch {
          return url + (url.includes("?") ? "&" : "?") + "ngrok-skip-browser-warning=1";
        }
      };
      finalHtml = normalizeButtonLinks(finalHtml);
      finalHtml = finalHtml.replace(/href=(['"])(.*?)\1/gi, (match, quote, url) => {
        if (!shouldTrackHref(url)) return match;

        const trackingUrl = withBypass(`${trackingBaseUrl}/api/campaign/track/${campaignId}/${leadId}/click/${uuidv4()}?url=${encodeURIComponent(url)}`);
        return `href=${quote}${trackingUrl}${quote}`;
      });

      const trackingPixelUrl = withBypass(`${trackingBaseUrl}/api/campaign/track/${campaignId}/${leadId}/open/${emailTrackingId}`);
      const trackingPixel = `<img src="${trackingPixelUrl}" width="1" height="1" border="0" style="width:1px;height:1px;min-width:1px;max-width:1px;min-height:1px;max-height:1px;border:0;outline:none;text-decoration:none;" alt="" />`;

      if (finalHtml.includes(TRACKING_PIXEL_MARKER)) {
        finalHtml = finalHtml.replaceAll(TRACKING_PIXEL_MARKER, trackingPixel);
      } else if (/<\/body>/i.test(finalHtml)) {
        finalHtml = finalHtml.replace(/<\/body>/i, `${trackingPixel}</body>`);
      } else {
        finalHtml = `${finalHtml}${trackingPixel}`;
      }
    }

    await sendEmail(to, subject, finalText, finalHtml);

    return {
      success: true,
      message: "Campaign email sent successfully",
      trackingId: campaignId && leadId ? emailTrackingId : null,
    };
  } catch (error) {
    logger.error("Error sending campaign email:", error);
    throw error;
  }
};

export {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendResendOTPEmail,
  sendCampaignEmail,
};
