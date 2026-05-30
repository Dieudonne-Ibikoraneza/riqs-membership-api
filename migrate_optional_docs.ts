// @ts-nocheck
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function migrate() {
  console.log("Starting migration of optional documents...");
  const categories = await prisma.membershipCategory.findMany();
  
  let updatedCount = 0;
  
  for (const cat of categories) {
    if (!cat.requiredDocuments) continue;
    
    const required: string[] = [];
    const optional: string[] = [...(cat.optionalDocuments || [])];
    let changed = false;
    
    for (const doc of cat.requiredDocuments) {
      if (doc.endsWith(" (Optional)")) {
        optional.push(doc.replace(" (Optional)", ""));
        changed = true;
      } else {
        required.push(doc);
      }
    }
    
    if (changed) {
      await prisma.membershipCategory.update({
        where: { id: cat.id },
        data: {
          requiredDocuments: required,
          optionalDocuments: optional,
        }
      });
      console.log(`Migrated ${cat.categoryName}: ${optional.length} optional docs`);
      updatedCount++;
    }
  }
  
  console.log(`Migration complete! Updated ${updatedCount} categories.`);
}

migrate()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect());
