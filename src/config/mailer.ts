import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import nodemailer from 'nodemailer';

const prisma = new PrismaClient();

// Load environment variables (support both local and Render env vars)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const SMTP_HOST = process.env.SMTP_HOST || 'mail.rwandaiqs.org';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const SMTP_SECURE = String(process.env.SMTP_SECURE ?? 'true').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

if (!SMTP_USER || !SMTP_PASSWORD) {
  console.warn("Warning: Missing SMTP_USER or SMTP_PASSWORD in .env. Emails will fail to send.");
}

// Exported for scheduled jobs and any callers that need direct SMTP access.
export const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  auth: SMTP_USER && SMTP_PASSWORD ? { user: SMTP_USER, pass: SMTP_PASSWORD } : undefined,
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

// Mail Send Dispatcher using EmailJS
export async function sendMail(to: string, templateId: string, payload: Record<string, any>, attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>) {
  try {
    // Fetch template from database
    const template = await prisma.emailTemplate.findUnique({
      where: { id: templateId }
    });

    if (!template) {
      throw new Error(`Email template with ID '${templateId}' not found in database.`);
    }

    // Interpolate variables into final HTML and subject
    const subject = interpolate(template.subject, payload);
    const html_content = interpolate(template.body, payload);

    const response = await transporter.sendMail({ from: SMTP_FROM, to, subject, html: html_content, attachments });
    console.log(`[SMTP] Dispatch Success to ${to}. Message ID: ${response.messageId}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[SMTP] Dispatch Failure to ${to}:`, error.message || error);
    throw error;
  }
}

// Raw Mail Dispatcher for Admin Broadcasts and Progression Notifications
export async function sendRawMail(options: { to: string, subject: string, html: string, attachments?: any[] }) {
  try {
    const response = await transporter.sendMail({
      from: SMTP_FROM,
      to: options.to,
      subject: options.subject,
      html: options.html,
      attachments: options.attachments,
    });
    console.log(`[SMTP] Raw Dispatch Success to ${options.to}. Message ID: ${response.messageId}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[SMTP] Raw Dispatch Failure to ${options.to}:`, error.message || error);
    throw error;
  }
}
