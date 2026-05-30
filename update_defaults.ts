import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const getDefaultDocuments = (draft: { entityType: string, location: string, categoryName: string }) => {
  const list: string[] = [];
  const catName = draft.categoryName || '';
  
  if (draft.entityType === 'Individual') {
    if (draft.location === 'Rwandan') {
      if (catName.includes('Graduate')) {
        list.push('Notarized Degree/Diploma (HEC equivalency if foreign)');
        list.push('Notarized Academic Transcripts showing subjects (Optional)');
        list.push('Certificate of RQSSA (or equivalent student membership proof)');
        list.push('Application Letter');
        list.push('Copy of ID / Passport');
        list.push('Curriculum Vitae (CV) (Optional)');
        list.push('Proof of Momo Payment (10,000 RWF via Momo Code: 604516)');
      } else if (catName.includes('Technologist')) {
        list.push('Diploma Certificate (HEC equivalency if foreign)');
        list.push('Notarized Academic Transcripts showing subjects');
        list.push('At least 2 CPD Activities certificate copies (Optional)');
        list.push('Logbook of records (Optional)');
        list.push('Application Letter');
        list.push('Copy of ID / Passport');
        list.push('Curriculum Vitae (CV) (Optional)');
        list.push('Proof of Momo Payment (10,000 RWF via Momo Code: 604516)');
      } else {
        list.push('Notarized Degree Certificate (HEC equivalent if foreign)');
        list.push('Notarized Academic Transcripts showing subjects');
        list.push('At least 2 CPD Activities certificate copies (Optional)');
        list.push('Logbook of records (Optional)');
        list.push('Application Letter');
        list.push('Copy of ID / Passport');
        list.push('Curriculum Vitae (CV) (Optional)');
        list.push('Proof of Momo Payment (10,000 RWF via Momo Code: 604516)');
      }
    } else {
      const isProf = catName.includes('Professional');
      list.push(isProf ? 'Notarized Degree Certificate' : 'Notarized Diploma Certificate');
      list.push('Valid Membership Certificate from country of origin');
      list.push('Visa & Work Permit (PDF)');
      list.push('CV & References (PDF) (Optional)');
      list.push(`Proof of Payment (${isProf ? '50 USD' : '30 USD'} Application Fee)`);
    }
  } else {
    const isLocal = draft.location === 'Rwandan';
    list.push(isLocal ? 'Firm Business Registration Certificate by RDB' : 'Firm Business Registration Certificate');
    list.push('Tax Clearance Certificate');
    list.push('Identity documents of beneficial owners / shareholders');
    list.push('Share certificates or company registry extract');
    list.push(isLocal ? 'RSSB Tax Clearance Certificate (Optional)' : 'Social Security Clearance Certificate (Optional)');
    if (isLocal) list.push('RIQS Members working in the firm (Certificates) (Optional)');
    const fee = catName.includes('Small') ? (isLocal ? '50,000 RWF' : '100 USD')
      : catName.includes('Medium') ? (isLocal ? '100,000 RWF' : '200 USD')
      : isLocal ? '200,000 RWF' : '400 USD';
    list.push(isLocal ? `Proof of Momo Payment (${fee} via Momo Code: 604516)` : `Proof of Payment (${fee} Application Fee)`);
  }
  return list;
};

async function updateDB() {
  const cats = await prisma.membershipCategory.findMany();
  for (const cat of cats) {
    if (!cat.requiredDocuments || cat.requiredDocuments.length === 0) {
      const docs = getDefaultDocuments(cat);
      await prisma.membershipCategory.update({
        where: { id: cat.id },
        data: { requiredDocuments: docs }
      });
      console.log('Updated ' + cat.categoryName);
    }
  }
  console.log('Done');
}
updateDB();
