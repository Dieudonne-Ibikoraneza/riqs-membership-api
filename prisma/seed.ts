import { PrismaClient, SystemRole, MemberClass } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const templates = [
  {
    id: "welcome",
    name: "Welcome to RIQS",
    category: "Onboarding",
    subject: "Welcome to the Rwanda Institute of Quantity Surveyors",
    description: "Sent to newly approved members after their application is accepted.",
    body: `<p class="mb-4">Dear <strong>{{name}}</strong>,</p>\n<p class="mb-4">On behalf of the Council and entire membership of the <strong>Rwanda Institute of Quantity Surveyors (RIQS)</strong>, we are delighted to officially welcome you as a registered member of the Institute.</p>\n<p class="mb-4">Your application has been <strong>reviewed and approved</strong>. You are now entitled to all privileges associated with your membership category, including:</p>\n<ul class="list-disc pl-5 mb-4 space-y-2">\n  <li>Access to your <strong>digital Annual Practicing License</strong> and verifiable certificate</li>\n  <li>Participation in <strong>Continuing Professional Development (CPD)</strong> events and workshops</li>\n  <li>Listing in the <strong>RIQS public members directory</strong></li>\n  <li>Eligibility to bid on <strong>government and private sector QS tenders</strong></li>\n  <li>Access to the <strong>mentorship programme</strong> for career advancement</li>\n</ul>\n<p class="mb-4">Please log in to the <strong>RIQS Members Portal</strong> to download your certificate, update your profile, and explore upcoming CPD opportunities.</p>\n<p class="mb-4">We look forward to your active participation in advancing the Quantity Surveying profession in Rwanda.</p>\n<p class="mb-4">Warm regards,<br/><strong>RIQS Secretariat</strong><br/>Rwanda Institute of Quantity Surveyors</p>`,
  },
  {
    id: "otpVerification",
    name: "OTP Email Verification",
    category: "Auth",
    subject: "RIQS - Verify your Email Address",
    description: "Sent to verify user email address during login or signup.",
    body: `<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.02);">
  <h2 style="color: #0f172a; border-bottom: 2px solid #3b82f6; padding-bottom: 12px; font-weight: 600; margin-top: 0;">Rwanda Institute of Quantity Surveyors (RIQS)</h2>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Dear <strong>{{name}}</strong>,</p>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Please use the verification code below to confirm your email address and complete your registration on the RIQS Digital Membership Registry.</p>
  <div style="background-color: #f8fafc; padding: 18px; border-left: 4px solid #3b82f6; border-radius: 6px; margin: 20px 0; text-align: center;">
    <p style="margin: 0; font-size: 13px; font-weight: 500; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Your Verification Code:</p>
    <p style="margin: 8px 0 0 0; font-size: 32px; font-weight: 700; color: #1e3a8a; letter-spacing: 4px;">{{otpCode}}</p>
  </div>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">This code is valid for 15 minutes. If you did not request this, please ignore this email.</p>
  <p style="margin-top: 30px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 18px; line-height: 1.4;">
    This is an automated notification from the RIQS Registry Portal. Please do not reply directly to this message.
  </p>
</div>`
  },
  {
    id: "passwordReset",
    name: "Password Reset Request",
    category: "Auth",
    subject: "RIQS Portal - Password Reset Request",
    description: "Sent when a user requests a password reset.",
    body: `<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.02);">
  <h2 style="color: #0f172a; border-bottom: 2px solid #3b82f6; padding-bottom: 12px; font-weight: 600; margin-top: 0;">RIQS Security</h2>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Dear <strong>{{name}}</strong>,</p>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">We received a request to reset your password for the RIQS Membership Portal. Use the following 6-digit code to complete the reset process. This code will expire in 15 minutes.</p>
  <div style="text-align: center; margin: 30px 0;">
    <span style="font-size: 32px; font-weight: 700; color: #1e3a8a; letter-spacing: 8px; background-color: #f8fafc; padding: 15px 30px; border-radius: 8px; border: 1px dashed #cbd5e1;">{{otpCode}}</span>
  </div>
  <p style="font-size: 14px; color: #64748b;">If you did not request a password reset, please ignore this email and your password will remain unchanged.</p>
</div>`
  },
  {
    id: "correctionRequired",
    name: "Correction Required",
    category: "Applications",
    subject: "Action Required: RIQS Application Correction Requested",
    description: "Sent when an application needs amendments or additional documents.",
    body: `<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.02);">
  <h2 style="color: #d97706; border-bottom: 2px solid #ea580c; padding-bottom: 12px; font-weight: 600; margin-top: 0;">Action Required: Correction Needed</h2>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Dear <strong>{{name}}</strong>,</p>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">During the administrative review of your RIQS membership application, some discrepancies were identified that require your correction before we can proceed.</p>
  <div style="background-color: #fffbeb; border-left: 4px solid #d97706; padding: 18px; margin: 20px 0; border-radius: 6px;">
    <h4 style="margin: 0 0 10px 0; color: #b45309; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">Reviewer Action Instructions:</h4>
    <p style="margin: 0; font-size: 14px; color: #78350f; line-height: 1.6; white-space: pre-line;">{{reviewerNotes}}</p>
  </div>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Please log in to the RIQS Portal, navigate to your form, correct the flagged details/documents, and re-submit your form for review.</p>
  <p style="margin-top: 30px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 18px; line-height: 1.4;">
    Office of the Registrar, Rwanda Institute of Quantity Surveyors (RIQS).
  </p>
</div>`
  },
  {
    id: "approved",
    name: "Application Approved",
    category: "Applications",
    subject: "CONGRATULATIONS! Your RIQS Membership is Approved",
    description: "Sent when an application is fully approved by the board.",
    body: `<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.02);">
  <h2 style="color: #16a34a; border-bottom: 2px solid #16a34a; padding-bottom: 12px; font-weight: 600; margin-top: 0;">Congratulations! Membership Approved</h2>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Dear <strong>{{name}}</strong>,</p>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">We are pleased to inform you that the board has officially approved your application for admission to the **{{category}}** category of the Rwanda Institute of Quantity Surveyors (RIQS).</p>
  <div style="background-color: #f0fdf4; border-left: 4px solid #16a34a; padding: 18px; margin: 20px 0; border-radius: 6px;">
    <p style="margin: 0; font-size: 13px; font-weight: 500; color: #166534; text-transform: uppercase; letter-spacing: 0.5px;">Your Assigned Professional RIQS ID:</p>
    <p style="margin: 8px 0 0 0; font-size: 20px; font-weight: 700; color: #14532d; letter-spacing: 1px;">{{membershipId}}</p>
  </div>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Your portal profile has transitioned to Phase B (Locked Registry Status). You can now log in to generate invoices for your annual subscription fees, download your e-certificate, or manage APC progressions.</p>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Welcome to the institute!</p>
  <p style="margin-top: 30px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 18px; line-height: 1.4;">
    Office of the Board, Rwanda Institute of Quantity Surveyors (RIQS).
  </p>
</div>`
  },
  {
    id: "rejected",
    name: "Application Rejected",
    category: "Applications",
    subject: "RIQS Registry - Application Decision Notification",
    description: "Sent when an application is rejected.",
    body: `<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.02);">
  <h2 style="color: #dc2626; border-bottom: 2px solid #dc2626; padding-bottom: 12px; font-weight: 600; margin-top: 0;">Application Status Update</h2>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Dear <strong>{{name}}</strong>,</p>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">We are writing to notify you that after a formal review by the administrative board, your application for RIQS membership has been declined.</p>
  <div style="background-color: #fef2f2; border-left: 4px solid #dc2626; padding: 18px; margin: 20px 0; border-radius: 6px;">
    <h4 style="margin: 0 0 10px 0; color: #991b1b; font-size: 13px; text-transform: uppercase; letter-spacing: 0.5px;">Rejection Rationale:</h4>
    <p style="margin: 0; font-size: 14px; color: #7f1d1d; line-height: 1.6; white-space: pre-line;">{{reason}}</p>
  </div>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">If you have any questions or wish to request an appeal, please reach out to the board secretary office directly.</p>
  <p style="margin-top: 30px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 18px; line-height: 1.4;">
    Board of Quantity Surveyors, Rwanda.
  </p>
</div>`
  },
  {
    id: "renewal",
    name: "Annual Renewal Reminder",
    category: "Billing",
    subject: "RIQS Annual Membership Renewal — Action Required",
    description: "Reminder sent to members whose annual license is approaching expiry.",
    body: `<p class="mb-4">Dear <strong>{{name}}</strong>,</p>\n<p class="mb-4">This is a friendly reminder that your <strong>RIQS Annual Practicing License</strong> is due for renewal. To maintain your active membership status and continue enjoying all member privileges, please complete the renewal process before the expiry date.</p>\n<p class="mb-4"><strong>Renewal Steps:</strong></p>\n<ol class="list-decimal pl-5 mb-4 space-y-2">\n  <li>Log in to the <strong>RIQS Members Portal</strong></li>\n  <li>Navigate to the <strong>Payments</strong> section</li>\n  <li>Complete the annual subscription payment via Mobile Money (Code: <strong>604516</strong>) or bank transfer</li>\n  <li>Upload your <strong>proof of payment</strong></li>\n</ol>\n<p class="mb-4"><strong>Important:</strong> Failure to renew before the deadline may result in temporary suspension of your practicing license, removal from the public directory, and inability to participate in CPD events.</p>\n<p class="mb-4">If you have already completed the renewal, please disregard this message. For any questions, contact our Secretariat at <strong>info@riqs.rw</strong>.</p>\n<p class="mb-4">Best regards,<br/><strong>RIQS Finance Department</strong><br/>Rwanda Institute of Quantity Surveyors</p>`,
  },
  {
    id: "cpd",
    name: "CPD Event Invitation",
    category: "Events",
    subject: "You're Invited: Upcoming RIQS CPD Professional Development Session",
    description: "Invitation to attend a scheduled CPD workshop or seminar.",
    body: `<p class="mb-4">Dear <strong>{{name}}</strong>,</p>\n<p class="mb-4">We are pleased to invite you to our upcoming <strong>Continuing Professional Development (CPD)</strong> session organized by the Rwanda Institute of Quantity Surveyors.</p>\n<p class="mb-4"><strong>Event Details:</strong></p>\n<ul class="list-disc pl-5 mb-4 space-y-2">\n  <li><strong>Topic:</strong> Modern Cost Estimation Techniques in East African Construction</li>\n  <li><strong>Date:</strong> Saturday, 15th June 2026</li>\n  <li><strong>Time:</strong> 09:00 AM — 01:00 PM (CAT)</li>\n  <li><strong>Venue:</strong> Kigali Convention Centre, Main Auditorium</li>\n  <li><strong>CPD Points:</strong> 4 points will be awarded upon completion</li>\n</ul>\n<p class="mb-4">This session will feature presentations by leading industry experts and will cover practical methodologies for improving project cost accuracy, risk assessment frameworks, and digital BIM integration in quantity surveying workflows.</p>\n<p class="mb-4"><strong>Registration is mandatory.</strong> Please confirm your attendance by replying to this email or through the Members Portal before <strong>10th June 2026</strong>.</p>\n<p class="mb-4">We look forward to seeing you there!</p>\n<p class="mb-4">Kind regards,<br/><strong>RIQS CPD Committee</strong><br/>Rwanda Institute of Quantity Surveyors</p>`,
  },
  {
    id: "mentorship-assign",
    name: "Mentorship Assignment",
    category: "Mentorship",
    subject: "RIQS Mentorship Programme — Mentor Assignment Confirmation",
    description: "Notification sent when a graduate is paired with a professional mentor.",
    body: `<p class="mb-4">Dear <strong>{{name}}</strong>,</p>\n<p class="mb-4">We are pleased to inform you that you have been successfully matched with a <strong>Professional Mentor</strong> under the RIQS Mentorship Programme.</p>\n<p class="mb-4"><strong>Your Assigned Mentor:</strong></p>\n<ul class="list-disc pl-5 mb-4 space-y-2">\n  <li><strong>Name:</strong> Eng. Patrick Nshuti, MRIQS</li>\n  <li><strong>Registration ID:</strong> RIQS-2020-P-015</li>\n  <li><strong>Specialization:</strong> Infrastructure & Civil Works Quantity Surveying</li>\n  <li><strong>Experience:</strong> 12 years in professional practice</li>\n</ul>\n<p class="mb-4">Your mentor will guide you through the practical experience requirements needed for advancement from Graduate to Technologist status. You are expected to:</p>\n<ol class="list-decimal pl-5 mb-4 space-y-2">\n  <li>Maintain a <strong>structured logbook</strong> of professional activities</li>\n  <li>Meet with your mentor at least <strong>once per month</strong></li>\n  <li>Complete a minimum of <strong>2 CPD activities</strong> per year</li>\n  <li>Submit quarterly <strong>progress reports</strong> through the Members Portal</li>\n</ol>\n<p class="mb-4">Your mentor has been notified and will reach out to schedule your first session. If you have any questions, please contact the RIQS Mentorship Coordinator.</p>\n<p class="mb-4">Best wishes,<br/><strong>RIQS Mentorship Committee</strong><br/>Rwanda Institute of Quantity Surveyors</p>`,
  },
  {
    id: "suspension",
    name: "Membership Suspension Notice",
    category: "Compliance",
    subject: "RIQS Membership Suspension — Immediate Action Required",
    description: "Formal suspension notice for non-compliance or overdue payments.",
    body: `<p class="mb-4">Dear <strong>{{name}}</strong>,</p>\n<p class="mb-4">We regret to inform you that your RIQS membership has been <strong>temporarily suspended</strong> effective immediately due to the following reason(s):</p>\n<ul class="list-disc pl-5 mb-4 space-y-2">\n  <li>Outstanding annual subscription payment exceeding <strong>90 days</strong> past the renewal deadline</li>\n  <li>Non-completion of the mandatory minimum <strong>CPD requirements</strong> for the current licensing year</li>\n</ul>\n<p class="mb-4"><strong>Impact of Suspension:</strong></p>\n<ul class="list-disc pl-5 mb-4 space-y-2">\n  <li>Your <strong>Annual Practicing License</strong> is no longer valid for professional engagements</li>\n  <li>Your profile has been <strong>removed from the public members directory</strong></li>\n  <li>You are <strong>ineligible to participate</strong> in RIQS events, tenders, or mentorship activities</li>\n</ul>\n<p class="mb-4">To reinstate your membership, please settle all outstanding obligations and contact the RIQS Secretariat at <strong>info@riqs.rw</strong> within <strong>30 days</strong>. After this period, a formal reinstatement application and additional fees may be required.</p>\n<p class="mb-4">Sincerely,<br/><strong>RIQS Compliance Office</strong><br/>Rwanda Institute of Quantity Surveyors</p>`,
  },
  {
    id: "agm",
    name: "AGM Invitation",
    category: "Events",
    subject: "Invitation to the RIQS Annual General Meeting 2026",
    description: "Annual General Meeting notice with agenda and logistics.",
    body: `<p class="mb-4">Dear <strong>{{name}}</strong>,</p>\n<p class="mb-4">You are cordially invited to attend the <strong>RIQS Annual General Meeting (AGM) 2026</strong>.</p>\n<p class="mb-4"><strong>Meeting Details:</strong></p>\n<ul class="list-disc pl-5 mb-4 space-y-2">\n  <li><strong>Date:</strong> Friday, 28th November 2026</li>\n  <li><strong>Time:</strong> 02:00 PM — 05:00 PM (CAT)</li>\n  <li><strong>Venue:</strong> Radisson Blu Hotel &amp; Convention Centre, Kigali</li>\n  <li><strong>Dress Code:</strong> Business formal</li>\n</ul>\n<p class="mb-4"><strong>Agenda:</strong></p>\n<ol class="list-decimal pl-5 mb-4 space-y-2">\n  <li>Opening remarks by the RIQS Chairman</li>\n  <li>Review and adoption of the 2025 AGM minutes</li>\n  <li>Presentation of the <strong>Annual Financial Report</strong></li>\n  <li>Report on membership growth, CPD statistics, and mentorship outcomes</li>\n  <li>Election of new <strong>Council Members</strong> for the 2027–2029 term</li>\n  <li>Discussion on the proposed <strong>QS Professional Standards Bill</strong></li>\n  <li>Any Other Business (AOB)</li>\n</ol>\n<p class="mb-4">Your attendance and participation are highly valued. Please RSVP by <strong>20th November 2026</strong> via the Members Portal or by replying to this email.</p>\n<p class="mb-4">With kind regards,<br/><strong>RIQS Secretariat</strong><br/>Rwanda Institute of Quantity Surveyors</p>`,
  },
  {
    id: "promotion",
    name: "Category Promotion",
    category: "Membership",
    subject: "Congratulations — RIQS Membership Category Advancement",
    description: "Congratulatory notice when a member is promoted to a higher category.",
    body: `<p class="mb-4">Dear <strong>{{name}}</strong>,</p>\n<p class="mb-4">We are thrilled to inform you that following a thorough review of your professional portfolio, practical experience records, and CPD achievements, the RIQS Assessment Committee has approved your <strong>category advancement</strong>.</p>\n<p class="mb-4"><strong>Promotion Details:</strong></p>\n<ul class="list-disc pl-5 mb-4 space-y-2">\n  <li><strong>Previous Category:</strong> Graduate Member (GRIQS)</li>\n  <li><strong>New Category:</strong> Technologist Member (TRIQS)</li>\n  <li><strong>Effective Date:</strong> 1st January 2027</li>\n</ul>\n<p class="mb-4">This promotion recognizes your dedication to professional development and your significant contributions to the Quantity Surveying profession. As a Technologist Member, you now have access to:</p>\n<ul class="list-disc pl-5 mb-4 space-y-2">\n  <li>Enhanced <strong>practicing rights</strong> for independent project engagement</li>\n  <li>Eligibility to <strong>mentor Graduate members</strong></li>\n  <li>Priority registration for <strong>advanced CPD workshops</strong></li>\n  <li>Voting rights at the <strong>Annual General Meeting</strong></li>\n</ul>\n<p class="mb-4">Your updated certificate and practicing license will be available for download in the Members Portal within 5 business days.</p>\n<p class="mb-4">Congratulations once again!</p>\n<p class="mb-4">Warm regards,<br/><strong>RIQS Council</strong><br/>Rwanda Institute of Quantity Surveyors</p>`,
  },
  {
    id: "invoice_generated",
    name: "New Invoice Generated",
    category: "Billing",
    subject: "New Invoice Available - RIQS Membership",
    description: "Sent automatically when a new unpaid invoice is generated.",
    body: `<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.02);">
  <h2 style="color: #0f172a; border-bottom: 2px solid #3b82f6; padding-bottom: 12px; font-weight: 600; margin-top: 0;">New Invoice Available</h2>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Dear <strong>{{name}}</strong>,</p>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">A new invoice for <strong>{{txType}}</strong> has been generated on your RIQS account.</p>
  
  <div style="background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 18px; margin: 20px 0; border-radius: 6px;">
    <p style="margin: 0; font-size: 13px; font-weight: 500; color: #64748b; text-transform: uppercase;">Amount Due:</p>
    <p style="margin: 8px 0 0 0; font-size: 24px; font-weight: 700; color: #1e3a8a;">{{currency}} {{amount}}</p>
    <p style="margin: 8px 0 0 0; font-size: 13px; color: #64748b;">Reference: {{reference}}</p>
  </div>
  
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Please log in to your Member Dashboard to view the invoice details and complete your payment securely.</p>
  <p style="margin-top: 30px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 18px; line-height: 1.4;">
    Finance Office, Rwanda Institute of Quantity Surveyors (RIQS).
  </p>
</div>`
  },
  {
    id: "apc_scheduled",
    name: "APC Board Scheduled",
    category: "Assessment",
    subject: "Your APC Board Assessment is Scheduled",
    description: "Sent automatically when an admin schedules an APC board assessment.",
    body: `<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 25px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff; box-shadow: 0 4px 6px rgba(0,0,0,0.02);">
  <h2 style="color: #0f172a; border-bottom: 2px solid #3b82f6; padding-bottom: 12px; font-weight: 600; margin-top: 0;">APC Board Scheduled</h2>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Dear <strong>{{name}}</strong>,</p>
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Your Assessment of Professional Competence (APC) Board review has been officially scheduled.</p>
  
  <div style="background-color: #f8fafc; border-left: 4px solid #3b82f6; padding: 18px; margin: 20px 0; border-radius: 6px;">
    <p style="margin: 0; font-size: 13px; font-weight: 500; color: #64748b; text-transform: uppercase;">Assessment Details:</p>
    <p style="margin: 8px 0 0 0; font-size: 16px; font-weight: 600; color: #1e3a8a;">Date: {{date}}</p>
    <p style="margin: 8px 0 0 0; font-size: 15px; color: #334155;">Panel Chair: {{chair}}</p>
    <p style="margin: 4px 0 0 0; font-size: 15px; color: #334155;">Examiners: {{examiner1}}, {{examiner2}}</p>
  </div>
  
  <p style="font-size: 15px; color: #334155; line-height: 1.6;">Please ensure you arrive on time and have all necessary documentation prepared. Best of luck!</p>
  <p style="margin-top: 30px; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 18px; line-height: 1.4;">
    Secretariat, Rwanda Institute of Quantity Surveyors (RIQS).
  </p>
</div>`
  }
];

const getDefaultDocuments = (draft: { entityType: string, location: string, categoryName: string }) => {
  const list: {name: string, typeCode: string}[] = [];
  const catName = draft.categoryName || "";
  
  if (draft.entityType === "Individual") {
    if (draft.location === "Rwandan") {
      if (catName.includes("Graduate")) {
        list.push({ name: "Notarized Degree/Diploma (HEC equivalency if foreign)", typeCode: "certificate" });
        list.push({ name: "Notarized Academic Transcripts showing subjects (Optional)", typeCode: "transcript" });
        list.push({ name: "Certificate of RQSSA (or equivalent student membership proof)", typeCode: "certificate" });
        list.push({ name: "Application Letter", typeCode: "application_letter" });
        list.push({ name: "Copy of ID / Passport", typeCode: "id_passport" });
        list.push({ name: "Curriculum Vitae (CV) (Optional)", typeCode: "cv" });
        list.push({ name: "Proof of Momo Payment (10,000 RWF via Momo Code: 604516)", typeCode: "payment" });
      } else if (catName.includes("Technologist")) {
        list.push({ name: "Diploma Certificate (HEC equivalency if foreign)", typeCode: "certificate" });
        list.push({ name: "Notarized Academic Transcripts showing subjects", typeCode: "transcript" });
        list.push({ name: "At least 2 CPD Activities certificate copies (Optional)", typeCode: "certificate" });
        list.push({ name: "Logbook of records (Optional)", typeCode: "logbook" });
        list.push({ name: "Application Letter", typeCode: "application_letter" });
        list.push({ name: "Copy of ID / Passport", typeCode: "id_passport" });
        list.push({ name: "Curriculum Vitae (CV) (Optional)", typeCode: "cv" });
        list.push({ name: "Proof of Momo Payment (10,000 RWF via Momo Code: 604516)", typeCode: "payment" });
      } else {
        list.push({ name: "Notarized Degree Certificate (HEC equivalent if foreign)", typeCode: "certificate" });
        list.push({ name: "Notarized Academic Transcripts showing subjects", typeCode: "transcript" });
        list.push({ name: "At least 2 CPD Activities certificate copies (Optional)", typeCode: "certificate" });
        list.push({ name: "Logbook of records (Optional)", typeCode: "logbook" });
        list.push({ name: "Application Letter", typeCode: "application_letter" });
        list.push({ name: "Copy of ID / Passport", typeCode: "id_passport" });
        list.push({ name: "Curriculum Vitae (CV) (Optional)", typeCode: "cv" });
        list.push({ name: "Proof of Momo Payment (10,000 RWF via Momo Code: 604516)", typeCode: "payment" });
      }
    } else {
      const isProf = catName.includes("Professional");
      list.push({ name: isProf ? "Notarized Degree Certificate" : "Notarized Diploma Certificate", typeCode: "certificate" });
      list.push({ name: "Valid Membership Certificate from country of origin", typeCode: "certificate" });
      list.push({ name: "Visa & Work Permit (PDF)", typeCode: "permit" });
      list.push({ name: "CV & References (PDF) (Optional)", typeCode: "cv" });
      list.push({ name: `Proof of Payment (${isProf ? "50 USD" : "30 USD"} Application Fee)`, typeCode: "payment" });
    }
  } else {
    const isLocal = draft.location === "Rwandan";
    list.push({ name: isLocal ? "Firm Business Registration Certificate by RDB" : "Firm Business Registration Certificate", typeCode: "business_registration" });
    list.push({ name: "Tax Clearance Certificate", typeCode: "tax_clearance" });
    list.push({ name: "Identity documents of beneficial owners / shareholders", typeCode: "id_passport" });
    list.push({ name: "Share certificates or company registry extract", typeCode: "certificate" });
    list.push({ name: isLocal ? "RSSB Tax Clearance Certificate (Optional)" : "Social Security Clearance Certificate (Optional)", typeCode: "tax_clearance" });
    if (isLocal) list.push({ name: "RIQS Members working in the firm (Certificates) (Optional)", typeCode: "certificate" });
    const fee = catName.includes("Small") ? (isLocal ? "50,000 RWF" : "100 USD")
      : catName.includes("Medium") ? (isLocal ? "100,000 RWF" : "200 USD")
      : isLocal ? "200,000 RWF" : "400 USD";
    list.push({ name: isLocal ? `Proof of Momo Payment (${fee} via Momo Code: 604516)` : `Proof of Payment (${fee} Application Fee)`, typeCode: "payment" });
  }
  
  const requiredDocuments: {name: string, typeCode: string}[] = [];
  const optionalDocuments: {name: string, typeCode: string}[] = [];
  
  for (const doc of list) {
    if (doc.name.endsWith(" (Optional)")) {
      optionalDocuments.push({ name: doc.name.replace(" (Optional)", ""), typeCode: doc.typeCode });
    } else {
      requiredDocuments.push(doc);
    }
  }

  return { requiredDocuments, optionalDocuments };
};

async function main() {
  const categoriesData = [
    // Rwandan Individuals (Rwandan)
    { location: 'Rwandan', entityType: 'Individual', categoryName: 'Graduate Quantity Surveying Technologist (Route 1)', categoryCode: 'GQST', processingFee: 10000.00, currency: 'RWF', firstYearFee: 50000.00, annualRenewalFee: 70000.00, stampFee: 0.00 },
    { location: 'Rwandan', entityType: 'Individual', categoryName: 'Graduate Quantity Surveyor (Route 2)', categoryCode: 'GQS', processingFee: 10000.00, currency: 'RWF', firstYearFee: 50000.00, annualRenewalFee: 100000.00, stampFee: 50000.00 },
    { location: 'Rwandan', entityType: 'Individual', categoryName: 'Quantity Surveying Technologist (Route 3)', categoryCode: 'QST', processingFee: 10000.00, currency: 'RWF', firstYearFee: 0.00, annualRenewalFee: 100000.00, stampFee: 50000.00 },
    { location: 'Rwandan', entityType: 'Individual', categoryName: 'Professional Quantity Surveyor (Route 4)', categoryCode: 'PQS', processingFee: 10000.00, currency: 'RWF', firstYearFee: 0.00, annualRenewalFee: 200000.00, stampFee: 50000.00 },
    // Non-Rwandan Individuals (Non_Rwandan)
    { location: 'Non_Rwandan', entityType: 'Individual', categoryName: 'Non-Rwandan Quantity Surveying Technologist', categoryCode: 'FQST', processingFee: 30.00, currency: 'USD', firstYearFee: 100.00, annualRenewalFee: 100.00, stampFee: 0.00 },
    { location: 'Non_Rwandan', entityType: 'Individual', categoryName: 'Non-Rwandan Professional Quantity Surveyor', categoryCode: 'FPQS', processingFee: 50.00, currency: 'USD', firstYearFee: 200.00, annualRenewalFee: 200.00, stampFee: 0.00 },
    // Rwandan Firms (Rwandan)
    { location: 'Rwandan', entityType: 'Firm', categoryName: 'Rwandan Small Firm (<50M Rwf)', categoryCode: 'LF-SM', processingFee: 50000.00, currency: 'RWF', firstYearFee: 300000.00, annualRenewalFee: 300000.00, stampFee: 0.00 },
    { location: 'Rwandan', entityType: 'Firm', categoryName: 'Rwandan Medium Firm (50-100M Rwf)', categoryCode: 'LF-MD', processingFee: 100000.00, currency: 'RWF', firstYearFee: 500000.00, annualRenewalFee: 500000.00, stampFee: 0.00 },
    { location: 'Rwandan', entityType: 'Firm', categoryName: 'Rwandan Large Firm (>100M Rwf)', categoryCode: 'LF-LG', processingFee: 200000.00, currency: 'RWF', firstYearFee: 1000000.00, annualRenewalFee: 1000000.00, stampFee: 0.00 },
    // Non-Rwandan Firms (Non_Rwandan)
    { location: 'Non_Rwandan', entityType: 'Firm', categoryName: 'Non-Rwandan Small Firm (<100K USD)', categoryCode: 'FF-SM', processingFee: 100.00, currency: 'USD', firstYearFee: 1000.00, annualRenewalFee: 1000.00, stampFee: 0.00 },
    { location: 'Non_Rwandan', entityType: 'Firm', categoryName: 'Non-Rwandan Medium Firm (100-500K USD)', categoryCode: 'FF-MD', processingFee: 200.00, currency: 'USD', firstYearFee: 2000.00, annualRenewalFee: 2000.00, stampFee: 0.00 },
    { location: 'Non_Rwandan', entityType: 'Firm', categoryName: 'Non-Rwandan Large Firm (>500K USD)', categoryCode: 'FF-LG', processingFee: 400.00, currency: 'USD', firstYearFee: 3000.00, annualRenewalFee: 3000.00, stampFee: 0.00 },
  ];

  await prisma.membershipCategory.createMany({
    data: categoriesData.map(cat => {
      const docs = getDefaultDocuments(cat);
      return {
        ...cat,
        location: cat.location as any,
        entityType: cat.entityType as any,
        requiredDocuments: docs.requiredDocuments,
        optionalDocuments: docs.optionalDocuments,
      };
    }),
    skipDuplicates: true
  });
  console.log('Database seeded with membership categories.');

  // Create testing users for different system roles
  const defaultPassword = 'Password123!';
  const passwordHash = await bcrypt.hash(defaultPassword, 10);

  const testUsers = [
    {
      email: 'admin@riqs.com',
      fullName: 'Dieudonne Admin',
      systemRole: SystemRole.Admin,
      membershipClass: MemberClass.Professional,
      membershipId: 'RIQS-2010-PRO-0001',
      isEmailVerified: true,
      passwordHash
    },
    {
      email: 'reviewer@riqs.com',
      fullName: 'Dieudonne Reviewer',
      systemRole: SystemRole.Reviewer,
      membershipClass: MemberClass.Professional,
      membershipId: 'RIQS-2015-PRO-0002',
      isEmailVerified: true,
      passwordHash
    },
    {
      email: 'approver@riqs.com',
      fullName: 'Dieudonne Approver',
      systemRole: SystemRole.Approver,
      membershipClass: MemberClass.Professional,
      membershipId: 'RIQS-2015-PRO-0003',
      isEmailVerified: true,
      passwordHash
    },
    {
      email: 'teacher@riqs.com',
      fullName: 'Dieudonne Teacher',
      systemRole: SystemRole.Teacher,
      membershipClass: MemberClass.Professional,
      membershipId: 'RIQS-2012-PRO-0003',
      isEmailVerified: true,
      passwordHash
    },
    {
      email: 'mentor@riqs.com',
      fullName: 'Dieudonne Mentor',
      systemRole: SystemRole.Mentor,
      membershipClass: MemberClass.Technologist,
      membershipId: 'RIQS-2018-TECH-0001',
      isEmailVerified: true,
      phoneNumber: '+250788123456',
      passwordHash
    }
  ];

  for (const user of testUsers) {
    await prisma.member.upsert({
      where: { email: user.email },
      update: {},
      create: user
    });
  }
  
  console.log('Database seeded with testing users (Admin, Reviewer, Approver, Teacher, Mentor).');

  const documentTypeBuckets = [
    { code: 'payment', name: 'Payment', isPaymentProof: true, appliesTo: 'Both' },
    { code: 'application_letter', name: 'Application Letter', isPaymentProof: false, appliesTo: 'Both' },
    { code: 'cv', name: 'CV / Resume', isPaymentProof: false, appliesTo: 'Both' },
    { code: 'certificate', name: 'Certificate', isPaymentProof: false, appliesTo: 'Both' },
    { code: 'transcript', name: 'Transcript', isPaymentProof: false, appliesTo: 'Individual' },
    { code: 'id_passport', name: 'ID / Passport', isPaymentProof: false, appliesTo: 'Both' },
    { code: 'photo', name: 'Passport Photo', isPaymentProof: false, appliesTo: 'Individual' },
    { code: 'logbook', name: 'Logbook', isPaymentProof: false, appliesTo: 'Individual' },
    { code: 'report', name: 'Report / Annual Report', isPaymentProof: false, appliesTo: 'Firm' },
    { code: 'business_registration', name: 'Business Registration Document', isPaymentProof: false, appliesTo: 'Firm' },
    { code: 'tax_clearance', name: 'Tax Clearance', isPaymentProof: false, appliesTo: 'Firm' },
    { code: 'permit', name: 'Visa / Work Permit', isPaymentProof: false, appliesTo: 'Individual' },
    { code: 'other', name: 'Other', isPaymentProof: false, appliesTo: 'Both' },
  ];

  console.log('Seeding document type buckets...');
  await prisma.documentType.deleteMany({});
  for (const bucket of documentTypeBuckets) {
    await prisma.documentType.create({ data: bucket });
  }
  console.log(`Seeded ${documentTypeBuckets.length} document type buckets.`);

  for (const t of templates) {
    await prisma.emailTemplate.upsert({
      where: { id: t.id },
      update: {
        name: t.name,
        category: t.category,
        subject: t.subject,
        description: t.description,
        body: t.body,
      },
      create: {
        id: t.id,
        name: t.name,
        category: t.category,
        subject: t.subject,
        description: t.description,
        body: t.body,
      },
    });
  }
  console.log('Database seeded with', templates.length, 'email templates.');
}

main()
  .catch((e) => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
