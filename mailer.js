// mailer.js
// Send email via Gmail SMTP using the same App Password we use for IMAP.
// No extra OAuth setup — just reuses GMAIL_USER + GMAIL_APP_PASSWORD.

import nodemailer from "nodemailer";

let _transport = null;

function transport() {
  if (_transport) return _transport;

  const user = process.env.GMAIL_USER;
  const pass = (process.env.GMAIL_APP_PASSWORD || "").replace(/\s+/g, "");
  if (!user || !pass) {
    throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD must be set");
  }

  _transport = nodemailer.createTransport({
    host:   "smtp.gmail.com",
    port:   465,
    secure: true,
    auth:   { user, pass },
  });
  return _transport;
}

/**
 * Send an email. Returns { messageId } on success.
 * Logs failures but throws so the agent can surface them to the user.
 */
export async function sendEmail({ to, subject, body, html, cc, bcc, replyTo }) {
  if (!to || !subject || (!body && !html)) {
    throw new Error("sendEmail requires to + subject + body or html");
  }

  const info = await transport().sendMail({
    from:    process.env.GMAIL_USER,
    to,
    cc,
    bcc,
    replyTo: replyTo,
    subject,
    text:    body,
    html:    html,
  });

  console.log(`[mailer] sent to ${to} — messageId=${info.messageId}`);
  return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
}
