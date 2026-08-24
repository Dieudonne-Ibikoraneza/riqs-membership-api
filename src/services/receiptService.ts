import PDFDocument from 'pdfkit';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/db';
import { supabaseAdmin } from '../config/db';
import { sendMail } from '../config/mailer';

// Deterministic, human-readable receipt number derived from the transaction's own id —
// no separate counter/sequence needed, and it's stable if this ever runs twice.
export function buildReceiptNumber(transactionId: string): string {
  return `RIQS-RCT-${transactionId.replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

const TX_TYPE_LABELS: Record<string, string> = {
  Processing_Fee: 'Application Processing Fee',
  First_Year_Fee: 'First Year Membership Fee',
  Annual_Renewal: 'Annual Membership Renewal',
  Stamp_Fee: 'Stamp Fee',
  APC_Fee: 'APC Assessment Fee'
};

function generateReceiptPdfBuffer(data: {
  receiptNumber: string;
  memberName: string;
  memberEmail: string;
  amount: string;
  currency: string;
  txTypeLabel: string;
  paymentMethod: string;
  transactionReference: string;
  categoryName?: string | null;
  paidAt: Date;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const LEFT_X = 50;
    const RIGHT_X = 320;
    const LABEL_WIDTH = 130;
    const dateLabel = data.paidAt.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });

    doc.font('Helvetica-Bold').fontSize(24).fillColor('#111111').text('Receipt', LEFT_X, 50);

    const metaRow = (y: number, label: string, value: string) => {
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111').text(label, LEFT_X, y, { width: LABEL_WIDTH });
      doc.font('Helvetica').fontSize(10).fillColor('#111111').text(value, LEFT_X + LABEL_WIDTH, y);
    };

    metaRow(95, 'Receipt number', data.receiptNumber);
    metaRow(112, 'Date paid', dateLabel);

    const partyY = 150;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111').text('RIQS', LEFT_X, partyY, { continued: true });
    doc.font('Helvetica').fontSize(9).fillColor('#2563eb').text('  @riqs', { link: 'https://ricos.rwandaiqs.org', underline: true });
    doc.font('Helvetica').fontSize(9).fillColor('#444444')
      .text('secretariat@riqs.rw', LEFT_X, partyY + 16)
      .text('Business Heights Center (BHC) Building', LEFT_X, partyY + 30)
      .text('332R+2VH, KG 7 Ave, Kigali, Rwanda', LEFT_X, partyY + 44);

    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111').text('Bill to', RIGHT_X, partyY);
    doc.font('Helvetica').fontSize(9).fillColor('#444444')
      .text(data.memberName, RIGHT_X, partyY + 16)
      .text(data.memberEmail, RIGHT_X, partyY + 30);

    const amountY = 230;
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111')
      .text(`${data.currency} ${Number(data.amount).toLocaleString()} paid on ${dateLabel}`, LEFT_X, amountY);

    const tableY = 270;
    const col1 = LEFT_X;
    const col2 = 300;
    const col3 = 430;

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666666')
      .text('Description', col1, tableY)
      .text('Category', col2, tableY)
      .text('Total Amount', col3, tableY, { width: 115, align: 'right' });

    doc.strokeColor('#dddddd').lineWidth(1).moveTo(LEFT_X, tableY + 16).lineTo(545, tableY + 16).stroke();

    const rowY = tableY + 26;
    doc.font('Helvetica').fontSize(10).fillColor('#111111')
      .text(data.txTypeLabel, col1, rowY, { width: 240 })
      .text(data.categoryName || '—', col2, rowY, { width: 120 })
      .text(`${data.currency} ${Number(data.amount).toLocaleString()}`, col3, rowY, { width: 115, align: 'right' });

    doc.end();
  });
}

// Called whenever a FinancialTransaction transitions to Paid, from either the
// member-initiated gateway flow or an admin's manual verification. Idempotent —
// skips silently if a receipt was already issued for this transaction.
export async function issuePaymentReceipt(transactionId: string): Promise<void> {
  const transaction = await prisma.financialTransaction.findUnique({
    where: { id: transactionId },
    include: {
      member: { select: { fullName: true, email: true } },
      application: { include: { category: { select: { categoryName: true } } } }
    }
  });

  if (!transaction || transaction.status !== 'Paid' || transaction.receiptUrl) {
    return;
  }

  const receiptNumber = buildReceiptNumber(transaction.id);
  const paidAt = transaction.clearedAt || new Date();

  const pdfBuffer = await generateReceiptPdfBuffer({
    receiptNumber,
    memberName: transaction.member.fullName,
    memberEmail: transaction.member.email,
    amount: transaction.amount.toString(),
    currency: transaction.currency,
    txTypeLabel: TX_TYPE_LABELS[transaction.txType] || transaction.txType,
    paymentMethod: transaction.paymentMethod,
    transactionReference: transaction.transactionReference,
    categoryName: transaction.application?.category?.categoryName || null,
    paidAt
  });

  const fileName = `${receiptNumber}.pdf`;

  // Only application-linked transactions can be catalogued as an UploadedDocument
  // (that model requires a non-null applicationId) so they show up in the admin
  // transaction view's "Receipt Document" panel. Other transaction types still get
  // the emailed PDF, just not a stored/browsable copy.
  if (transaction.applicationId) {
    const filePath = `applications/${transaction.applicationId}/${fileName}`;

    const { error: storageError } = await supabaseAdmin.storage
      .from('riqs-membership')
      .upload(filePath, pdfBuffer, {
        contentType: 'application/pdf',
        cacheControl: '3600',
        upsert: true
      });

    if (storageError) {
      console.error('[Payment Receipt] Storage upload failed:', storageError.message);
    } else {
      const documentId = uuidv4();
      await prisma.$transaction([
        prisma.uploadedDocument.create({
          data: {
            id: documentId,
            applicationId: transaction.applicationId,
            documentType: 'Payment_Receipt',
            fileName,
            fileUrl: filePath,
            fileSizeBytes: pdfBuffer.length
          }
        }),
        prisma.financialTransaction.update({
          where: { id: transaction.id },
          data: { receiptUrl: documentId }
        })
      ]);
    }
  }

  try {
    await sendMail(transaction.member.email, 'paymentReceipt', {
      name: transaction.member.fullName,
      receiptNumber,
      amount: Number(transaction.amount).toLocaleString(),
      currency: transaction.currency,
      txTypeLabel: TX_TYPE_LABELS[transaction.txType] || transaction.txType
    }, [{ filename: fileName, content: pdfBuffer, contentType: 'application/pdf' }]);
  } catch (mailErr: any) {
    console.error('[Payment Receipt] Email dispatch failed:', mailErr.message);
  }
}
