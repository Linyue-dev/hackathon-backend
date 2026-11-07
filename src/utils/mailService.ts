import { MailtrapClient } from "mailtrap";

/**
 * Send an email with Mailtrap.
 * Without MAILTRAP_API_TOKEN nothing is sent and the email is printed to the
 * console instead, so development works without an email account.
 * Environment: MAILTRAP_API_TOKEN, MAIL_FROM_EMAIL, MAIL_FROM_NAME (optional).
 */
export async function sendMail(params: {
  recipientEmail: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<void> {
  const { recipientEmail, subject, text, html } = params;

  const token = process.env.MAILTRAP_API_TOKEN;
  if (!token) {
    console.log(
      `[email not sent: MAILTRAP_API_TOKEN is not set] to ${recipientEmail} - ${subject}\n${text}`,
    );
    return;
  }

  const fromEmail = process.env.MAIL_FROM_EMAIL;
  if (!fromEmail) throw new Error("MAIL_FROM_EMAIL is not set");

  const client = new MailtrapClient({ token });
  await client.send({
    from: {
      name: process.env.MAIL_FROM_NAME ?? "JacHacks Judging",
      email: fromEmail,
    },
    to: [{ email: recipientEmail }],
    subject,
    text,
    ...(html ? { html } : {}),
  });
}
