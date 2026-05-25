import * as nodemailer from 'nodemailer';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env.local') });

const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
const smtpPort = parseInt(process.env.SMTP_PORT || '465', 10);
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASSWORD;

if (!smtpUser || !smtpPass) {
  console.error("Critical Error: Missing SMTP credentials in .env.local.");
}

// 1. Instantiate Transporter using Gmail SMTP SSL connection
export const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465,
  auth: {
    user: smtpUser,
    pass: smtpPass
  }
});

// Verify connection on startup
transporter.verify((error, success) => {
  if (error) {
    console.error('[SMTP Mailer] Connection Verification Failed:', error.message);
  } else {
    console.log('[SMTP Mailer] Successfully connected to Gmail SMTP. Transporter ready.');
  }
});

/**
 * Interpolates variables into a template string
 * e.g., interpolate("Hello {{name}}", { name: "John" }) -> "Hello John"
 */
function interpolate(template: string, variables: Record<string, any>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] !== undefined ? String(variables[key]) : match;
  });
}

// Mail Send Dispatcher
export async function sendMail(to: string, templateId: string, payload: Record<string, any>) {
  try {
    // Fetch template from database
    const template = await prisma.emailTemplate.findUnique({
      where: { id: templateId }
    });

    if (!template) {
      throw new Error(`Email template with ID '${templateId}' not found in database.`);
    }

    // Interpolate variables
    const subject = interpolate(template.subject, payload);
    const html = interpolate(template.body, payload);

    const info = await transporter.sendMail({
      from: `"RIQS Registry Portal" <${smtpUser}>`,
      to,
      subject,
      html
    });
    console.log(`[SMTP Mailer] Dispatch Success to ${to}. MessageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error: any) {
    console.error(`[SMTP Mailer] Dispatch Failure to ${to}:`, error.message);
    throw error;
  }
}
