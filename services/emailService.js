const nodemailer = require("nodemailer");

/**
 * Create Gmail SMTP transporter using process.env.GMAIL_USER and process.env.GMAIL_APP_PASSWORD
 */
function getTransporter() {
  const user = process.env.GMAIL_USER ? process.env.GMAIL_USER.trim() : "";
  const pass = process.env.GMAIL_APP_PASSWORD ? process.env.GMAIL_APP_PASSWORD.trim() : "";

  if (!user || !pass) {
    console.warn("[Email Service] WARNING: GMAIL_USER or GMAIL_APP_PASSWORD is missing in environment.");
  }

  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: user || "",
      pass: pass || "",
    },
  });
}

/**
 * Validate email format (basic check)
 */
function isValidEmail(email) {
  if (!email || typeof email !== "string") return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Send email via Gmail SMTP using Nodemailer
 * @param {Object} options
 * @param {string|string[]} options.to - Recipient email address(es)
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.text] - Plain text body fallback
 */
async function sendEmail({ to, subject, html, text }) {
  const recipients = Array.isArray(to) ? to : [to];
  const invalidEmails = recipients.filter((email) => !isValidEmail(email));

  if (invalidEmails.length > 0) {
    const errorMsg = `Invalid recipient email address(es): ${invalidEmails.join(", ")}`;
    console.error(`[Email Service] Validation Error: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }

  const gUser = process.env.GMAIL_USER ? process.env.GMAIL_USER.trim() : "";
  const gPass = process.env.GMAIL_APP_PASSWORD ? process.env.GMAIL_APP_PASSWORD.trim() : "";

  if (!gUser || !gPass) {
    const errorMsg = "Gmail SMTP is not configured. GMAIL_USER and GMAIL_APP_PASSWORD must be defined in .env";
    console.error(`[Email Service] Configuration Error: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }

  if (!subject || typeof subject !== "string" || !subject.trim()) {
    const errorMsg = "Email subject is required.";
    console.error(`[Email Service] Validation Error: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }

  if (!html && !text) {
    const errorMsg = "Email body content (html or text) is required.";
    console.error(`[Email Service] Validation Error: ${errorMsg}`);
    return { success: false, error: errorMsg };
  }

  const fromName = process.env.EMAIL_FROM_NAME || "NovaChat";
  const from = `${fromName} <${gUser}>`;

  try {
    const transporter = getTransporter();
    
    // Verify SMTP connection and auth credentials before sending
    await transporter.verify();
    console.log(`[Email Service] SMTP authentication verified successfully for user: ${gUser}`);

    console.log(`[Email Service] Dispatching email:`);
    console.log(`  Sender (From): ${from}`);
    console.log(`  Recipient(s) (To): ${recipients.join(", ")}`);
    console.log(`  Subject: ${subject.trim()}`);

    const info = await transporter.sendMail({
      from,
      to: recipients.join(", "),
      subject: subject.trim(),
      html: html || undefined,
      text: text || undefined,
    });

    // Log the complete response from the email provider
    console.log(`[Email Service] Full Provider Response from Gmail SMTP:`, {
      messageId: info.messageId,
      response: info.response,
      accepted: info.accepted,
      rejected: info.rejected,
      envelope: info.envelope,
    });

    // Check if recipient was rejected by SMTP server
    if (info.rejected && info.rejected.length > 0) {
      const errorMsg = `Recipient address rejected by SMTP server: ${info.rejected.join(", ")}`;
      console.error(`[Email Service] Delivery Error: ${errorMsg}`);
      return { success: false, error: errorMsg, providerResponse: info };
    }

    if (!info.messageId) {
      const errorMsg = "SMTP server accepted message but failed to return a valid Message-ID.";
      console.error(`[Email Service] Delivery Error: ${errorMsg}`);
      return { success: false, error: errorMsg, providerResponse: info };
    }

    console.log(`[Email Service] Email confirmed delivered to SMTP queue! Message ID: ${info.messageId}`);
    return {
      success: true,
      id: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
    };
  } catch (err) {
    console.error(`[Email Service] Failed to send email via Gmail SMTP:`, err);
    return {
      success: false,
      error: err.message || "Failed to send email via Gmail SMTP",
    };
  }
}

/**
 * Send Password Reset Email template
 */
async function sendPasswordResetEmail(toEmail, resetLink) {
  const subject = "Reset Your NovaChat Password 🔐";
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Inter', system-ui, -apple-system, sans-serif; background-color: #050505; color: #ffffff; margin: 0; padding: 40px 20px; }
        .container { max-width: 500px; margin: 0 auto; background: #111111; border: 1px solid #262626; border-radius: 16px; padding: 36px; text-align: center; }
        .logo { width: 56px; height: 56px; border-radius: 16px; background: linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045); margin: 0 auto 20px; line-height: 56px; font-size: 26px; }
        h1 { font-size: 22px; font-weight: 700; margin-bottom: 10px; color: #ffffff; }
        p { color: #a8a8a8; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
        .btn { display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045); color: #ffffff !important; text-decoration: none; font-weight: 600; border-radius: 10px; font-size: 14px; letter-spacing: 0.3px; }
        .footer { margin-top: 30px; font-size: 12px; color: #555555; word-break: break-all; }
        .fallback-link { color: #c13584; text-decoration: underline; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">💬</div>
        <h1>Reset Your Password</h1>
        <p>We received a request to reset your NovaChat password. Click the button below to choose a new password:</p>
        <a href="${resetLink}" class="btn">Reset My Password</a>
        <p style="margin-top: 24px; font-size: 12px; color: #737373;">
          ⚠️ This link will expire in <strong>15 minutes</strong> and can only be used once.
        </p>
        <div class="footer">
          <p>If you didn't request a password reset, you can safely ignore this email.</p>
          <p>Fallback link:<br><a href="${resetLink}" class="fallback-link">${resetLink}</a></p>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmail({ to: toEmail, subject, html: htmlContent });
}

/**
 * Send Welcome Email to newly registered users
 */
async function sendWelcomeEmail(toEmail, displayName) {
  const name = displayName || toEmail.split("@")[0];
  const subject = `Welcome to NovaChat, ${name}! 👋`;
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: 'Inter', system-ui, -apple-system, sans-serif; background-color: #050505; color: #ffffff; margin: 0; padding: 40px 20px; }
        .container { max-width: 500px; margin: 0 auto; background: #111111; border: 1px solid #262626; border-radius: 16px; padding: 36px; text-align: center; }
        .logo { width: 56px; height: 56px; border-radius: 16px; background: linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045); margin: 0 auto 20px; line-height: 56px; font-size: 26px; }
        h1 { font-size: 22px; font-weight: 700; margin-bottom: 10px; color: #ffffff; }
        p { color: #a8a8a8; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
        .footer { margin-top: 30px; font-size: 12px; color: #555555; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">🚀</div>
        <h1>Welcome to NovaChat!</h1>
        <p>Hi <strong>${name}</strong>,</p>
        <p>Thank you for joining NovaChat! We are excited to have you on board. Connect with your friends, share media, and chat in real-time.</p>
        <div class="footer">
          <p>© NovaChat. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmail({ to: toEmail, subject, html: htmlContent });
}

module.exports = {
  sendEmail,
  sendPasswordResetEmail,
  sendWelcomeEmail,
  isValidEmail,
};
