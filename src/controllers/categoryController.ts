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

// 3. Update Category (Admin Only)
export async function updateCategory(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const {
      category_name,
      processing_fee,
      currency,
      first_year_fee,
      annual_renewal_fee,
      stamp_fee
    } = req.body;

    const existingCat = await prisma.membershipCategory.findUnique({ where: { id } });
    if (!existingCat) {
      return res.status(404).json({ error: 'Membership category not found.' });
    }

    const updatedCat = await prisma.membershipCategory.update({
      where: { id },
      data: {
        categoryName: category_name !== undefined ? category_name : existingCat.categoryName,
        processingFee: processing_fee !== undefined ? processing_fee : existingCat.processingFee,
        currency: currency !== undefined ? currency : existingCat.currency,
        firstYearFee: first_year_fee !== undefined ? first_year_fee : existingCat.firstYearFee,
        annualRenewalFee: annual_renewal_fee !== undefined ? annual_renewal_fee : existingCat.annualRenewalFee,
        stampFee: stamp_fee !== undefined ? stamp_fee : existingCat.stampFee,
      }
    });

    return res.status(200).json({
      message: 'Category updated successfully.',
      category: {
        id: updatedCat.id,
        location: updatedCat.location,
        entity_type: updatedCat.entityType,
        category_name: updatedCat.categoryName,
        category_code: updatedCat.categoryCode,
        processing_fee: updatedCat.processingFee,
        currency: updatedCat.currency,
        first_year_fee: updatedCat.firstYearFee,
        annual_renewal_fee: updatedCat.annualRenewalFee,
        stamp_fee: updatedCat.stampFee
      }
    });
  } catch (error: any) {
    console.error('[Update Category] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error updating category.' });
  }
}
