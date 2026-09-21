/**
 * Outgoing email.
 *
 * Used for one thing today: sending a student their marked writing, with the
 * mistakes crossed out and the corrections beside them, so they have it to
 * keep and print.
 *
 * Configured entirely in the environment — the app never stores or asks for a
 * mail password:
 *
 *   SMTP_HOST   e.g. smtp.gmail.com
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

export function emailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
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
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
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
    return { sent: false, reason: 'email is not configured (SMTP_HOST / SMTP_USER / SMTP_PASS)' };
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
