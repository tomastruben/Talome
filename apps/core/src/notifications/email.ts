import { createTransport } from "nodemailer";

export interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  useTls?: boolean;
  username?: string;
  password?: string;
  from: string;
  to: string[];
}

/**
 * Send an email notification via SMTP.
 * Throws on failure — caller should catch.
 */
export async function sendEmail(
  config: EmailConfig,
  subject: string,
  body: string,
  level: string,
): Promise<void> {
  const transport = createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    ...(config.useTls !== false ? { requireTLS: config.smtpPort !== 465 } : {}),
    ...(config.username
      ? { auth: { user: config.username, pass: config.password ?? "" } }
      : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });

  const levelEmoji = level === "critical" ? "\u{1F6A8}" : level === "warning" ? "\u26A0\uFE0F" : "\u2139\uFE0F";

  await transport.sendMail({
    from: config.from,
    to: config.to.join(", "),
    subject: `${levelEmoji} [Talome] ${subject}`,
    text: `${subject}\n\n${body}\n\n— Talome`,
    html: `
      <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 500px;">
        <p style="font-size: 14px; color: ${level === "critical" ? "#e54" : level === "warning" ? "#ea0" : "#888"}; font-weight: 600; margin: 0 0 4px;">
          ${level.toUpperCase()}
        </p>
        <h2 style="margin: 0 0 12px; font-size: 18px;">${subject}</h2>
        <p style="color: #666; font-size: 14px; line-height: 1.5; margin: 0;">${body}</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;" />
        <p style="color: #aaa; font-size: 12px; margin: 0;">Sent by Talome</p>
      </div>
    `,
  });

  transport.close();
}

/**
 * Test SMTP connectivity by sending a test email.
 */
export async function testEmailChannel(config: EmailConfig): Promise<void> {
  await sendEmail(config, "Test notification", "If you received this, email notifications are working.", "info");
}
