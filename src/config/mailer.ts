import * as nodemailer from 'nodemailer';
import * as dotenv from 'dotenv';
import * as path from 'path';

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

// 2. Custom Rich HTML Templates matching dynamic status warning levels
export const mailTemplates = {
  welcome: (name: string, trackingNumber?: string) => ({
    subject: "Welcome to RIQS - Digital Membership Account Created",
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.02);">
        <h2 style="color: #0f172a; border-bottom: 2px solid #3b82f6; padding-bottom: 12px; font-weight: 600; margin-top: 0;">Rwanda Institute of Quantity Surveyors (RIQS)</h2>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">Dear <strong>${name}</strong>,</p>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">Your professional registration portal account has been successfully created on the RIQS Digital Membership Registry.</p>
        ${trackingNumber ? `
          <div style="background-color: #f8fafc; padding: 18px; border-left: 4px solid #3b82f6; border-radius: 6px; margin: 20px 0;">
            <p style="margin: 0; font-size: 13px; font-weight: 500; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Your Mentor Structured Training ID:</p>
            <p style="margin: 8px 0 0 0; font-size: 20px; font-weight: 700; color: #1e3a8a; letter-spacing: 1px;">${trackingNumber}</p>
          </div>
        ` : ''}
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">Please log in to your dashboard to complete your 7-step profile form, upload required notarized documents, and submit your initial processing fee.</p>
        <p style="margin-top: 30px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 18px; line-height: 1.4;">
          This is an automated notification from the RIQS Registry Portal. Please do not reply directly to this message.
        </p>
      </div>
    `
  }),

  correctionRequired: (name: string, reviewerNotes: string) => ({
    subject: "Action Required: RIQS Application Correction Requested",
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.02);">
        <h2 style="color: #d97706; border-bottom: 2px solid #ea580c; padding-bottom: 12px; font-weight: 600; margin-top: 0;">Action Required: Correction Needed</h2>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">Dear <strong>${name}</strong>,</p>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">During the administrative review of your RIQS membership application, some discrepancies were identified that require your correction before we can proceed.</p>
        <div style="background-color: #fffbeb; border-left: 4px solid #d97706; padding: 18px; margin: 20px 0; border-radius: 6px;">
          <h4 style="margin: 0 0 10px 0; color: #b45309; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Reviewer Action Instructions:</h4>
          <p style="margin: 0; font-size: 14px; color: #78350f; line-height: 1.6; white-space: pre-line;">${reviewerNotes}</p>
        </div>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">Please log in to the RIQS Portal, navigate to your form, correct the flagged details/documents, and re-submit your form for review.</p>
        <p style="margin-top: 30px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 18px; line-height: 1.4;">
          Office of the Registrar, Rwanda Institute of Quantity Surveyors (RIQS).
        </p>
      </div>
    `
  }),

  approved: (name: string, membershipId: string, category: string) => ({
    subject: "CONGRATULATIONS! Your RIQS Membership is Approved",
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.02);">
        <h2 style="color: #16a34a; border-bottom: 2px solid #16a34a; padding-bottom: 12px; font-weight: 600; margin-top: 0;">Congratulations! Membership Approved</h2>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">Dear <strong>${name}</strong>,</p>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">We are pleased to inform you that the board has officially approved your application for admission to the **${category}** category of the Rwanda Institute of Quantity Surveyors (RIQS).</p>
        <div style="background-color: #f0fdf4; border-left: 4px solid #16a34a; padding: 18px; margin: 20px 0; border-radius: 6px;">
          <p style="margin: 0; font-size: 13px; font-weight: 500; color: #166534; text-transform: uppercase; letter-spacing: 0.5px;">Your Assigned Professional RIQS ID:</p>
          <p style="margin: 8px 0 0 0; font-size: 20px; font-weight: 700; color: #14532d; letter-spacing: 1px;">${membershipId}</p>
        </div>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">Your portal profile has transitioned to Phase B (Locked Registry Status). You can now log in to generate invoices for your annual subscription fees, download your e-certificate, or manage APC progressions.</p>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">Welcome to the institute!</p>
        <p style="margin-top: 30px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 18px; line-height: 1.4;">
          Office of the Board, Rwanda Institute of Quantity Surveyors (RIQS).
        </p>
      </div>
    `
  }),

  rejected: (name: string, reason: string) => ({
    subject: "RIQS Registry - Application Decision Notification",
    html: `
      <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.02);">
        <h2 style="color: #dc2626; border-bottom: 2px solid #dc2626; padding-bottom: 12px; font-weight: 600; margin-top: 0;">Application Status Update</h2>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">Dear <strong>${name}</strong>,</p>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">We are writing to notify you that after a formal review by the administrative board, your application for RIQS membership has been declined.</p>
        <div style="background-color: #fef2f2; border-left: 4px solid #dc2626; padding: 18px; margin: 20px 0; border-radius: 6px;">
          <h4 style="margin: 0 0 10px 0; color: #991b1b; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Rejection Rationale:</h4>
          <p style="margin: 0; font-size: 14px; color: #7f1d1d; line-height: 1.6; white-space: pre-line;">${reason}</p>
        </div>
        <p style="font-size: 15px; color: #334155; line-height: 1.6;">If you have any questions or wish to request an appeal, please reach out to the board secretary office directly.</p>
        <p style="margin-top: 30px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 18px; line-height: 1.4;">
          Board of Quantity Surveyors, Rwanda.
        </p>
      </div>
    `
  })
};

// Mail Send Dispatcher
export async function sendMail(to: string, template: { subject: string; html: string }) {
  try {
    const info = await transporter.sendMail({
      from: `"RIQS Registry Portal" <${smtpUser}>`,
      to,
      subject: template.subject,
      html: template.html
    });
    console.log(`[SMTP Mailer] Dispatch Success to ${to}. MessageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error: any) {
    console.error(`[SMTP Mailer] Dispatch Failure to ${to}:`, error.message);
    throw error;
  }
}
