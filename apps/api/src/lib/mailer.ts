import nodemailer from "nodemailer";
import { env } from "../env.js";

let transporter: nodemailer.Transporter | null = null;

function mailer(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport(env().SMTP_URL);
  }
  return transporter;
}

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
}): Promise<void> {
  await mailer().sendMail({ from: env().MAIL_FROM, ...opts });
}

export async function sendVerificationEmail(
  to: string,
  token: string,
): Promise<void> {
  const url = `${env().APP_BASE_URL}/verify-email?token=${token}`;
  await sendMail({
    to,
    subject: `Verify your ${env().APP_NAME} email address`,
    text: `Welcome to ${env().APP_NAME}!\n\nVerify your email address by opening:\n${url}\n\nIf you did not create this account, ignore this message.`,
  });
}

export async function sendPasswordResetEmail(
  to: string,
  token: string,
): Promise<void> {
  const url = `${env().APP_BASE_URL}/reset-password?token=${token}`;
  await sendMail({
    to,
    subject: `Reset your ${env().APP_NAME} password`,
    text: `A password reset was requested for your account.\n\nReset it here:\n${url}\n\nThis link expires in 30 minutes. If you did not request a reset, ignore this message.`,
  });
}
