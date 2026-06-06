import emailjs from '@emailjs/nodejs';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Load environment variables (support both local and Render env vars)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;

if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY) {
  console.warn("Warning: Missing EmailJS credentials in .env. Emails will fail to send.");
}

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
export async function sendMail(to: string, templateId: string, payload: Record<string, any>) {
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

    // Send via EmailJS
    // Requires a template on EmailJS with variables: {{to_email}}, {{subject}}, {{{html_content}}}
    const response = await emailjs.send(
      EMAILJS_SERVICE_ID!,
      EMAILJS_TEMPLATE_ID!,
      {
        to_email: to,
        subject: subject,
        html_content: html_content
      },
      {
        publicKey: EMAILJS_PUBLIC_KEY,
        privateKey: EMAILJS_PRIVATE_KEY
      }
    );

    console.log(`[EmailJS] Dispatch Success to ${to}. Status: ${response.status} ${response.text}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EmailJS] Dispatch Failure to ${to}:`, error.message || error.text || error);
    throw error;
  }
}

// Raw Mail Dispatcher for Admin Broadcasts and Progression Notifications
export async function sendRawMail(options: { to: string, subject: string, html: string, attachments?: any[] }) {
  try {
    // Note: EmailJS free tier has a strict 50kb limit on attachments. 
    // Attachments must be base64 data URIs. We map them if provided, but warn the user.
    if (options.attachments && options.attachments.length > 0) {
      console.warn("[EmailJS] Attachments are not fully supported on the free tier (50kb limit) and require Base64 encoding. They may be dropped.");
    }

    const response = await emailjs.send(
      EMAILJS_SERVICE_ID!,
      EMAILJS_TEMPLATE_ID!,
      {
        to_email: options.to,
        subject: options.subject,
        html_content: options.html
      },
      {
        publicKey: EMAILJS_PUBLIC_KEY,
        privateKey: EMAILJS_PRIVATE_KEY
      }
    );

    console.log(`[EmailJS] Raw Dispatch Success to ${options.to}. Status: ${response.status}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[EmailJS] Raw Dispatch Failure to ${options.to}:`, error.message || error.text || error);
    throw error;
  }
}
