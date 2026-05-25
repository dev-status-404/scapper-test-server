/**
 * Email Queue Service using an in-process queue
 *
 * Architecture:
 *  - One in-memory queue: "email-campaign"
 *  - One worker loop: processes each job and sends via nodemailer using the
 *    SMTP credentials stored on the campaign's smtp_account_id.
 */

import nodemailer from "nodemailer";
import crypto from "crypto";
import Campaign from "../models/campaign.model.js";
import EmailTracking from "../models/emailTracking.model.js";
import EmailTemplate from "../models/emailTemplate.model.js";
import UserSmtpAccount from "../models/userSmtpAccount.model.js";
import {
  bindErrorContext,
  captureException,
  withMonitoringSpan,
} from "../monitoring/index.js";
import { createNotification } from "./notificationService.js";
import { InMemoryJobQueue } from "../utils/inMemoryJobQueue.js";

// ─── Queue definition ─────────────────────────────────────────────────────────

export const emailCampaignQueue = new InMemoryJobQueue("email-campaign", {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { age: 86400 }, // keep completed jobs 24 h
    removeOnFail: { age: 7 * 86400 }, // keep failed jobs 7 days
  },
});

// ─── SMTP transporter factory ─────────────────────────────────────────────────

const ALGORITHM = "aes-256-gcm";

const decryptPassword = (encryptedData) => {
  try {
    const ENCRYPTION_KEY = process.env.CRYPTO_SECRET_KEY;
    if (!ENCRYPTION_KEY) throw new Error("CRYPTO_SECRET_KEY not set");
    const key = Buffer.from(ENCRYPTION_KEY.slice(0, 64), "hex");
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(encryptedData.iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(encryptedData.authTag, "hex"));
    let decrypted = decipher.update(encryptedData.encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return JSON.parse(decrypted);
  } catch (err) {
    throw new Error("Failed to decrypt SMTP password: " + err.message);
  }
};

const createTransporter = (smtpAccount) => {
  const password = decryptPassword(smtpAccount.smtp.auth.encryptedPassword);
  return nodemailer.createTransport({
    host: smtpAccount.smtp.host,
    port: smtpAccount.smtp.port,
    secure: true,
    auth: { user: smtpAccount.username, pass: password },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
  });
};

// ─── Template renderer ────────────────────────────────────────────────────────

/**
 * Replace {{variable}} placeholders in the template content/subject.
 */
const renderTemplate = (text, variables = {}) => {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    variables[key] !== undefined ? variables[key] : `{{${key}}}`,
  );
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

const getApiBaseUrl = () => {
  const configured = [
    process.env.API_BASE_URL,
    process.env.APP_URL,
    process.env.BASE_URL,
  ].find(isUsableTrackingBaseUrl);

  if (!configured) {
    console.warn(
      "[EmailQueue] WARNING: No valid API_BASE_URL configured. " +
      "Email open/click tracking will not work for locally-sent emails. " +
      "Set API_BASE_URL in .env to the public URL of your backend server."
    );
  }

  const rawUrl = configured || "https://api.dataharvx.com";

  return rawUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");
};

/**
 * Appends '?ngrok-skip-browser-warning=1' to URLs that go through ngrok.
 * The ngrok free tier shows an interstitial HTML page for requests without
 * a session cookie (e.g. Google Image Proxy). The query param bypasses it.
 */
const withNgrokBypass = (url) => {
  if (!url || !url.toLowerCase().includes("ngrok")) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("ngrok-skip-browser-warning", "1");
    return u.toString();
  } catch {
    return url + (url.includes("?") ? "&" : "?") + "ngrok-skip-browser-warning=1";
  }
};

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

const addClickTracking = (html, { campaignId, leadId, trackingId }) => {
  if (!html || !campaignId || !leadId || !trackingId) return html;

  const baseUrl = getApiBaseUrl();
  return html.replace(/href=(["'])(.*?)\1/gi, (match, quote, url) => {
    if (!shouldTrackHref(url)) return match;

    const clickTrackingId = crypto.randomUUID();
    const rawTrackingUrl = `${baseUrl}/api/campaign/track/${campaignId}/${leadId}/click/${clickTrackingId}?url=${encodeURIComponent(url)}`;
    const trackingUrl = withNgrokBypass(rawTrackingUrl);
    return `href=${quote}${trackingUrl}${quote}`;
  });
};

const addOpenTrackingPixel = (html, { campaignId, leadId, trackingId }) => {
  if (!campaignId || !leadId || !trackingId) return html;

  const baseUrl = getApiBaseUrl();
  const rawPixelUrl = `${baseUrl}/api/campaign/track/${campaignId}/${leadId}/open/${trackingId}`;
  // withNgrokBypass appends ?ngrok-skip-browser-warning=1 for ngrok URLs so that
  // Gmail's Google Image Proxy (no session cookie) receives the GIF, not the
  // ngrok interstitial HTML page.
  const trackingPixelUrl = withNgrokBypass(rawPixelUrl);
  // Use proper email-safe 1x1 pixel — do NOT use display:none as some clients
  // skip loading hidden images entirely.
  const trackingPixel = `<img src="${trackingPixelUrl}" width="1" height="1" border="0" style="width:1px;height:1px;min-width:1px;max-width:1px;min-height:1px;max-height:1px;border:0;outline:none;text-decoration:none;" alt="" />`;
  const finalHtml = html || "";

  if (finalHtml.includes(TRACKING_PIXEL_MARKER)) {
    return finalHtml.replaceAll(TRACKING_PIXEL_MARKER, trackingPixel);
  }

  if (/<\/body>/i.test(finalHtml)) {
    return finalHtml.replace(/<\/body>/i, `${trackingPixel}</body>`);
  }

  return `${finalHtml}${trackingPixel}`;
};

const markCampaignFinishedIfComplete = async (campaignId) => {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign || ["SENT", "CANCELLED"].includes(campaign.status)) return;

  const analytics = campaign.analytics || {};
  const completed =
    Number(analytics.delivered || analytics.sent || 0) +
    Number(analytics.bounced || analytics.failed || 0);
  const expected = Number(campaign.total_recipients || 0);

  if (expected > 0 && completed >= expected) {
    campaign.status = "SENT";
    if (!campaign.sent_at) campaign.sent_at = new Date();
    await campaign.save();

    await createNotification({
      user_id: campaign.user_id,
      title: "Campaign completed",
      type: "info",
      message: `Campaign '${campaign.name}' completed. Sent: ${analytics.sent || 0}, Failed: ${analytics.failed || 0}`,
    }).catch(() => {});
  }
};

// ─── Worker ───────────────────────────────────────────────────────────────────

let emailWorkerInstance = null;
let emailWorkerListenersBound = false;

export const createEmailWorker = () => {
  if (emailWorkerInstance) {
    return emailWorkerInstance;
  }

  emailWorkerInstance = emailCampaignQueue.setProcessor(
    async (job) => {
      return withMonitoringSpan(
        "queue.email.process",
        {
          op: "queue.process",
          attributes: {
            "queue.name": "email-campaign",
            "queue.job_id": job.id,
            "campaign.id": job?.data?.campaignId || null,
            "lead.id": job?.data?.leadId || null,
          },
        },
        async () => {
          const {
            campaignId,
            leadId,
            to,
            leadName,
            subject,
            content,
            fromEmail,
            fromName,
            replyTo,
            smtpAccountId,
            trackingId,
          } = job.data;

          await Campaign.findOneAndUpdate(
            { _id: campaignId, status: "SCHEDULED" },
            { status: "SENDING", sent_at: new Date() },
          ).catch(() => {});

          const smtpAccount = await UserSmtpAccount.findById(smtpAccountId);
          if (!smtpAccount) throw new Error(`SMTP account ${smtpAccountId} not found`);

          const transporter = createTransporter(smtpAccount);

          const trackingParams = { campaignId, leadId, trackingId };
          const cleanContent = (content || "")
            .replace(/<img[^>]+\/api\/campaign\/track\/[^>]*>/gi, "")
            .replaceAll(TRACKING_PIXEL_MARKER, "");
          let finalHtml = wrapEmailHtml(cleanContent, { subject });
          finalHtml = normalizeButtonLinks(finalHtml);
          finalHtml = addClickTracking(finalHtml, trackingParams);
          finalHtml = addOpenTrackingPixel(finalHtml, trackingParams);

          const pixelMatch = finalHtml.match(/<img[^>]+\/api\/campaign\/track\/[^>]+>/i);
          console.log(
            `[EmailQueue] Tracking pixel embedded:`,
            pixelMatch ? pixelMatch[0] : "NOT FOUND - pixel missing from final HTML",
          );

          await transporter.sendMail({
            from: fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
            to,
            replyTo: replyTo || undefined,
            subject,
            html: finalHtml,
          });

          await EmailTracking.updateOne(
            { tracking_id: trackingId },
            {
              $set: {
                delivered_at: new Date(),
              },
              $setOnInsert: {
                campaign_id: campaignId,
                lead_id: leadId,
                tracking_id: trackingId,
                clicked: false,
                opened_at: null,
              },
            },
            { upsert: true },
          );

          await Campaign.findByIdAndUpdate(campaignId, {
            $inc: {
              "analytics.sent": 1,
              "analytics.delivered": 1,
            },
          });
          await markCampaignFinishedIfComplete(campaignId);
        },
      );
    },
    {
      concurrency: parseInt(process.env.EMAIL_WORKER_CONCURRENCY || "10", 10),
    },
  );

  if (emailWorkerListenersBound) {
    return emailWorkerInstance;
  }

  emailWorkerListenersBound = true;

  emailWorkerInstance.on("failed", async (job, err) => {
    console.error(`[EmailQueue] Job ${job?.id} failed:`, err.message);
    captureException(
      err,
      bindErrorContext({
        tags: {
          area: "queue",
          queue: "email-campaign",
          event: "job-failed",
          job_id: job?.id || null,
          campaign_id: job?.data?.campaignId || null,
          lead_id: job?.data?.leadId || null,
        },
        extra: {
          attempts_made: job?.attemptsMade || 0,
          max_attempts: job?.opts?.attempts || 1,
          recipient: job?.data?.to || null,
        },
      }),
    );
    if (job?.data?.campaignId) {
      const maxAttempts = job?.opts?.attempts || 1;
      if ((job?.attemptsMade || 0) < maxAttempts) return;

      await Campaign.findByIdAndUpdate(job.data.campaignId, {
        $inc: {
          "analytics.failed": 1,
          "analytics.bounced": 1,
        },
      }).catch(() => {});
      await markCampaignFinishedIfComplete(job.data.campaignId).catch(() => {});
    }
  });

  return emailWorkerInstance;
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enqueue all emails for a campaign.
 * Resolves template content if template_id is set, then adds one BullMQ job
 * per recipient lead.
 *
 * @param {Object} campaign  - Campaign document
 * @param {Array}  leads     - Array of Lead documents
 * @param {Date|null} scheduledAt - Future date to delay delivery (null = send now)
 */
export const enqueueCampaignEmails = async (campaign, leads, scheduledAt = null) => {
  // Resolve content & subject (template takes priority over inline content)
  let subject = campaign.subject;
  let content = campaign.content;

  if (campaign.template_id) {
    const template = await EmailTemplate.findById(campaign.template_id);
    if (template) {
      subject = subject || template.subject;
      content = content || template.content;

      // Track template usage
      await EmailTemplate.findByIdAndUpdate(campaign.template_id, {
        $inc: { usage_count: 1 },
        last_used_at: new Date(),
      });
    }
  }

  if (!campaign.smtp_account_id) {
    // Fallback: resolve smtp_account_id from from_email on the campaign
    if (campaign.from_email) {
      const smtpAccount = await UserSmtpAccount.findOne({
        user_id: campaign.user_id,
        email_address: campaign.from_email,
        is_deleted: { $ne: true },
      }).lean();
      if (smtpAccount) {
        campaign.smtp_account_id = smtpAccount._id;
        // Persist the resolved ID back to the campaign
        await Campaign.findByIdAndUpdate(campaign._id, {
          smtp_account_id: smtpAccount._id,
        });
      }
    }
    if (!campaign.smtp_account_id) {
      throw new Error("Campaign has no smtp_account_id set");
    }
  }

  // Calculate BullMQ delay in milliseconds (0 = immediate)
  const delay =
    scheduledAt && new Date(scheduledAt) > new Date()
      ? new Date(scheduledAt).getTime() - Date.now()
      : 0;

  const jobs = [];

  for (const lead of leads) {
    if (!lead.emails || lead.emails.length === 0) {
      await Campaign.findByIdAndUpdate(campaign._id, {
        $inc: {
          "analytics.failed": 1,
          "analytics.bounced": 1,
        },
      });
      continue;
    }

    const { v4: uuidv4 } = await import("uuid");
    const trackingId = uuidv4();
    const leadName =
      `${lead.first_name || ""} ${lead.last_name || ""}`.trim() ||
      "Valued Customer";

    // Render per-lead template variables
    const variables = {
      leadName,
      firstName: lead.first_name || "",
      lastName: lead.last_name || "",
      email: lead.emails[0],
      company: lead.company || "",
      campaignName: campaign.name,
    };

    jobs.push({
      name: `campaign:${campaign._id}:lead:${lead._id}`,
      data: {
        campaignId: campaign._id.toString(),
        leadId: lead._id.toString(),
        to: lead.emails[0],
        leadName,
        subject: renderTemplate(subject, variables),
        content: renderTemplate(content, variables),
        fromEmail: campaign.from_email,
        fromName: campaign.from_name || "",
        replyTo: campaign.reply_to || "",
        smtpAccountId: campaign.smtp_account_id.toString(),
        trackingId,
      },
      opts: delay > 0 ? { delay } : {},
    });
  }

  if (jobs.length > 0) {
    await emailCampaignQueue.addBulk(jobs);
  }

  return jobs.length;
};
