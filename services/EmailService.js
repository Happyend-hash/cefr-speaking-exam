/**
 * Outgoing email.
 *
 * Used for sign-up verification codes, and for sending a student their marked
 * writing with the mistakes crossed out and the corrections beside them.
 *
 * Configured entirely in the environment — the app never stores or asks for a
 * mail password. Two ways to send; Brevo wins when both are set:
 *
 *   BREVO_API_KEY  Brevo's HTTPS email API (api.brevo.com). Required on
 *                  Railway's Free/Trial/Hobby plans, which block outgoing SMTP
 *                  entirely — every SMTP attempt there just times out. The
 *                  sender is MAIL_FROM, which must be a sender verified in the
 *                  Brevo account.
 *
 *   SMTP_HOST   e.g. smtp.gmail.com (only where the host allows outgoing SMTP)
 *   SMTP_PORT   465 (SSL) or 587 (STARTTLS); defaults to 465
 *   SMTP_USER   the sending account
 *   SMTP_PASS   its password — for Gmail, an App Password, not the account
 *               password
 *   MAIL_FROM   optional display sender, e.g. "CEFR Mock <you@gmail.com>"
 *   APP_URL     optional; the site address used for the "open your result" link
 *
 * Unset, email is simply off: marking still completes and the result is on
 * screen. A missing mail setup must never cost a student their mark.
 */

let transporterPromise = null;

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

/** "CEFR Mock <you@gmail.com>" or "you@gmail.com" -> { name?, email }, or null. */
export function parseSender(raw = process.env.MAIL_FROM || process.env.SMTP_USER || '') {
  const match = String(raw).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (match) {
    const name = match[1].trim();
    return name ? { name, email: match[2].trim() } : { email: match[2].trim() };
  }
  return String(raw).includes('@') ? { email: String(raw).trim() } : null;
}

function brevoConfigured() {
  return Boolean(process.env.BREVO_API_KEY && parseSender());
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

export function emailConfigured() {
  return brevoConfigured() || smtpConfigured();
}

async function sendViaBrevo({ to, subject, html, text }) {
  const response = await fetch(BREVO_URL, {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      sender: parseSender(),
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text
    }),
    // Same reasoning as the SMTP timeouts below: fail fast so a caller that
    // awaits this (resend) can tell the student, rather than hang.
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    // Brevo explains itself in the body — an unverified sender, a bad key, a
    // used-up daily quota. Keep that in the log line; it's the diagnosis.
    const detail = await response.text().catch(() => '');
    throw new Error(`Brevo rejected the email (${response.status}): ${detail.slice(0, 300)}`);
  }
  return { sent: true };
}

async function transporter() {
  if (!transporterPromise) {
    transporterPromise = (async () => {
      // Imported on first use so a deployment without mail configured never
      // loads it at all.
      const { default: nodemailer } = await import('nodemailer');
      const port = Number(process.env.SMTP_PORT) || 465;
      return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: port === 465,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        // Without these, nodemailer's own defaults apply: up to 2 minutes to
        // even establish a connection, up to 10 minutes of socket silence.
        // A slow or unreachable SMTP host would hang any caller that awaits
        // sendMail() (e.g. resendVerificationEmail) for that entire time
        // instead of failing fast and letting the caller tell the student.
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 15000
      });
    })().catch(error => {
      transporterPromise = null;
      throw error;
    });
  }
  return transporterPromise;
}

export async function sendMail({ to, subject, html, text }) {
  if (!emailConfigured()) {
    return { sent: false, reason: 'email is not configured (BREVO_API_KEY + MAIL_FROM, or SMTP_HOST / SMTP_USER / SMTP_PASS)' };
  }
  if (brevoConfigured()) {
    return sendViaBrevo({ to, subject, html, text });
  }
  const mailer = await transporter();
  await mailer.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
    text
  });
  return { sent: true };
}

export default { emailConfigured, sendMail };
