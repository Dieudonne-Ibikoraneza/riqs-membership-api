import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { PracticeLocation, EntityType } from '@prisma/client';

// 1. Fetch all membership categories (public — needed by frontend registration wizard)
export async function getAllCategories(req: Request, res: Response) {
  try {
    const { location, entityType } = req.query;
    
    const whereClause: any = {};
    if (location) whereClause.location = location as PracticeLocation;
    if (entityType) whereClause.entityType = entityType as EntityType;

    const categories = await prisma.membershipCategory.findMany({
      where: whereClause,
      orderBy: [
        { location: 'asc' },
        { entityType: 'asc' },
        { categoryName: 'asc' }
      ]
    });

    // Formatting to snake_case for frontend compatibility since our Prisma schema maps to camelCase
    const formattedCategories = categories.map(cat => ({
      id: cat.id,
      location: cat.location,
      entity_type: cat.entityType,
      category_name: cat.categoryName,
      category_code: cat.categoryCode,
      processing_fee: cat.processingFee,
      currency: cat.currency,
      first_year_fee: cat.firstYearFee,
      annual_renewal_fee: cat.annualRenewalFee,
      stamp_fee: cat.stampFee
    }));

    return res.status(200).json({ categories: formattedCategories });
  } catch (error: any) {
    console.error('[Get Categories] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching membership categories.' });
  }
}

// 2. Fetch a single category by ID
export async function getCategoryById(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const cat = await prisma.membershipCategory.findUnique({ where: { id } });

    if (!cat) {
      return res.status(404).json({ error: 'Membership category not found.' });
    }

    const formattedCategory = {
      id: cat.id,
      location: cat.location,
      entity_type: cat.entityType,
      category_name: cat.categoryName,
      category_code: cat.categoryCode,
      processing_fee: cat.processingFee,
      currency: cat.currency,
      first_year_fee: cat.firstYearFee,
      annual_renewal_fee: cat.annualRenewalFee,
      stamp_fee: cat.stampFee
    };

    return res.status(200).json({ category: formattedCategory });
  } catch (error: any) {
    console.error('[Get Category By ID] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching category details.' });
  }
}
