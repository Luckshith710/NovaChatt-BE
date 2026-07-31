const nodemailer = require("nodemailer");

/**
 * Create Gmail SMTP transporter using process.env.GMAIL_USER and process.env.GMAIL_APP_PASSWORD
 */
function getTransporter() {
  const user = process.env.GMAIL_USER ? process.env.GMAIL_USER.trim() : "";
  // Google App Passwords are shown as '4-char 4-char 4-char 4-char' (with spaces)
  // but SMTP requires the raw 16-character string with NO spaces whatsoever.
  const pass = process.env.GMAIL_APP_PASSWORD
    ? process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, "")
    : "";

  if (!user || !pass) {
    console.warn("[Email Service] WARNING: GMAIL_USER or GMAIL_APP_PASSWORD is missing in environment.");
  }

  console.log(`[Email Service] Transporter config → user: "${user}", pass length: ${pass.length} chars (spaces stripped)`);

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true, // use SSL
    auth: {
      user: user || "",
      pass: pass || "",
    },
    tls: {
      rejectUnauthorized: false
    },
    // Hard timeouts so the transporter never hangs the request indefinitely.
    connectionTimeout: 15000,
    greetingTimeout: 12000,
    socketTimeout: 20000,
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
  // Strip ALL whitespace — Google App Passwords have spaces between 4-char groups
  // in the UI but SMTP requires all 16 characters joined with no spaces.
  const gPass = process.env.GMAIL_APP_PASSWORD
    ? process.env.GMAIL_APP_PASSWORD.replace(/\s+/g, "")
    : "";

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

  // Hard deadline: if sendMail takes longer than 20 s the Promise.race
  // wins and we return an error instead of blocking the request forever.
  const SEND_TIMEOUT_MS = 20000;

  try {
    const transporter = getTransporter();

    // Run verify() only on localhost (where outbound SMTP ports are open).
    // On Render free tier, verify() can hang indefinitely due to port restrictions.
    // sendMail() handles auth failures on its own in production.
    if (process.env.NODE_ENV !== "production") {
      console.log(`[Email Service] Running transporter.verify() (dev/localhost only)...`);
      try {
        await transporter.verify();
        console.log(`[Email Service] ✅ SMTP verify() succeeded — credentials are valid.`);
      } catch (verifyErr) {
        console.error(`[Email Service] ❌ SMTP verify() FAILED:`);
        console.error(`  Message   : ${verifyErr.message}`);
        console.error(`  Code      : ${verifyErr.code || "N/A"}`);
        console.error(`  Response  : ${verifyErr.response || "N/A"}`);
        console.error(`  ResponseCode: ${verifyErr.responseCode || "N/A"}`);
        // Return immediately — no point trying sendMail if credentials are wrong
        return { success: false, error: verifyErr.message || "SMTP authentication failed" };
      }
    }

    console.log(`[Email Service] Preparing to send email via Gmail SMTP...`);
    console.log(`  Sender (From): ${from}`);
    console.log(`  Recipient(s) (To): ${recipients.join(", ")}`);
    console.log(`  Subject: ${subject.trim()}`);
    console.log(`  Timeout: ${SEND_TIMEOUT_MS / 1000}s`);

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Email send timed out after ${SEND_TIMEOUT_MS / 1000} seconds.`)),
        SEND_TIMEOUT_MS
      )
    );

    const mailOptions = {
      from,
      to: recipients.join(", "),
      replyTo: from,
      subject: subject.trim(),
      html: html || undefined,
      text: text || undefined,
      headers: {
        "X-Mailer": "NovaChat-Mailer/1.0",
        "X-Priority": "1 (Highest)",
        "X-MSMail-Priority": "High",
        "Importance": "High",
      },
    };

    console.log(`[Email Service] sendMail() called — awaiting SMTP response...`);

    // Execution with 1-attempt retry for transient socket/connection drops
    let info;
    try {
      const sendPromise = transporter.sendMail(mailOptions);
      info = await Promise.race([sendPromise, timeoutPromise]);
    } catch (primaryErr) {
      console.warn(`[Email Service] Primary SMTP send attempt failed: ${primaryErr.message}. Retrying in 1.5s...`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const retryPromise = transporter.sendMail(mailOptions);
      info = await Promise.race([retryPromise, timeoutPromise]);
    }

    console.log(`[Email Service] sendMail() returned.`);

    // Log the full provider response for backend diagnostics
    console.log(`[Email Service] Provider Response:`, {
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
      return { success: false, error: errorMsg };
    }

    if (!info.messageId) {
      const errorMsg = "SMTP server accepted message but did not return a Message-ID.";
      console.error(`[Email Service] Delivery Error: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }

    console.log(`[Email Service] ✅ Email queued successfully! Message ID: ${info.messageId}`);
    return {
      success: true,
      id: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
    };
  } catch (err) {
    console.error(`[Email Service] ❌ Failed to send email:`);
    console.error(`  Message     : ${err.message}`);
    console.error(`  Code        : ${err.code || "N/A"}`);
    console.error(`  ResponseCode: ${err.responseCode || "N/A"}`);
    console.error(`  SMTP Response: ${err.response || "N/A"}`);
    console.error(`  Command     : ${err.command || "N/A"}`);
    return {
      success: false,
      error: err.message || "Failed to send email via Gmail SMTP",
    };
  }
}

/**
 * Send Password Reset Email template with HTML & Plain-text Fallback
 */
async function sendPasswordResetEmail(toEmail, resetLink) {
  const subject = "Reset Your NovaChat Password 🔐";

  const textContent = `
Hello,

We received a request to reset your NovaChat password.

Click or paste the following secure link into your browser to choose a new password:
${resetLink}

⚠️ Note: This link will expire in 15 minutes and can only be used once.

If you didn't request a password reset, you can safely ignore this email. Your account remains secure.

Best regards,
The NovaChat Team
  `.trim();

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Reset Your NovaChat Password</title>
      <style>
        body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #050505; color: #ffffff; margin: 0; padding: 40px 20px; }
        .container { max-width: 500px; margin: 0 auto; background: #111111; border: 1px solid #262626; border-radius: 16px; padding: 36px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        .logo { width: 56px; height: 56px; border-radius: 16px; background: linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045); margin: 0 auto 20px; line-height: 56px; font-size: 26px; }
        h1 { font-size: 22px; font-weight: 700; margin-bottom: 12px; color: #ffffff; letter-spacing: -0.5px; }
        p { color: #a8a8a8; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }
        .btn { display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #833ab4, #fd1d1d, #fcb045); color: #ffffff !important; text-decoration: none; font-weight: 600; border-radius: 10px; font-size: 14px; letter-spacing: 0.3px; box-shadow: 0 4px 15px rgba(253,29,29,0.3); }
        .expiry { margin-top: 24px; font-size: 12px; color: #888888; background: #181818; padding: 10px 14px; border-radius: 8px; border: 1px solid #2a2a2a; }
        .footer { margin-top: 30px; font-size: 12px; color: #555555; word-break: break-all; border-top: 1px solid #222222; padding-top: 20px; }
        .fallback-link { color: #fcb045; text-decoration: underline; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">💬</div>
        <h1>Reset Your Password</h1>
        <p>We received a request to reset your NovaChat password. Click the button below to set a new password:</p>
        <a href="${resetLink}" class="btn" target="_blank" rel="noopener noreferrer">Reset My Password</a>
        <div class="expiry">
          ⚠️ This link expires in <strong>15 minutes</strong> and can only be used once.
        </div>
        <div class="footer">
          <p>If you didn't request a password reset, you can safely ignore this email.</p>
          <p style="margin-top:10px;">Direct Link:<br><a href="${resetLink}" class="fallback-link" target="_blank" rel="noopener noreferrer">${resetLink}</a></p>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmail({ to: toEmail, subject, html: htmlContent, text: textContent });
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
