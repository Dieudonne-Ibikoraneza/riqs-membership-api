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
      stamp_fee: cat.stampFee,
      required_documents: cat.requiredDocuments,
      optional_documents: cat.optionalDocuments
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
      stamp_fee: cat.stampFee,
      required_documents: cat.requiredDocuments,
      optional_documents: cat.optionalDocuments
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
      stamp_fee,
      required_documents,
      optional_documents
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
        requiredDocuments: required_documents !== undefined && Array.isArray(required_documents) ? required_documents : existingCat.requiredDocuments,
        optionalDocuments: optional_documents !== undefined && Array.isArray(optional_documents) ? optional_documents : existingCat.optionalDocuments,
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
        stamp_fee: updatedCat.stampFee,
        required_documents: updatedCat.requiredDocuments,
        optional_documents: updatedCat.optionalDocuments
      }
    });
  } catch (error: any) {
    console.error('[Update Category] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error updating category.' });
  }
}

// 4. Create Category (Admin Only)
export async function createCategory(req: Request, res: Response) {
  try {
    const {
      location,
      entity_type,
      category_name,
      category_code,
      processing_fee,
      currency,
      first_year_fee,
      annual_renewal_fee,
      stamp_fee,
      required_documents,
      optional_documents
    } = req.body;

    if (!location || !entity_type || !category_name || !category_code || processing_fee === undefined || first_year_fee === undefined || annual_renewal_fee === undefined) {
      return res.status(400).json({ error: 'Missing required fields to create a category.' });
    }

    const newCat = await prisma.membershipCategory.create({
      data: {
        location: location as PracticeLocation,
        entityType: entity_type as EntityType,
        categoryName: category_name,
        categoryCode: category_code,
        processingFee: processing_fee,
        currency: currency || 'RWF',
        firstYearFee: first_year_fee,
        annualRenewalFee: annual_renewal_fee,
        stampFee: stamp_fee || 0.00,
        requiredDocuments: required_documents || [],
        optionalDocuments: optional_documents || [],
      }
    });

    return res.status(201).json({
      message: 'Category created successfully.',
      category: {
        id: newCat.id,
        location: newCat.location,
        entity_type: newCat.entityType,
        category_name: newCat.categoryName,
        category_code: newCat.categoryCode,
        processing_fee: newCat.processingFee,
        currency: newCat.currency,
        first_year_fee: newCat.firstYearFee,
        annual_renewal_fee: newCat.annualRenewalFee,
        stamp_fee: newCat.stampFee,
        required_documents: newCat.requiredDocuments,
        optional_documents: newCat.optionalDocuments
      }
    });
  } catch (error: any) {
    console.error('[Create Category] Error:', error.message);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'A category with this name already exists.' });
    }
    return res.status(500).json({ error: 'Internal server error creating category.' });
  }
}

// 5. Delete Category (Admin Only)
export async function deleteCategory(req: Request, res: Response) {
  try {
    const { id } = req.params;

    // Check if category exists
    const existingCat = await prisma.membershipCategory.findUnique({ where: { id } });
    if (!existingCat) {
      return res.status(404).json({ error: 'Membership category not found.' });
    }

    // Optional: Check if there are applications tied to this category before deleting
    const appsCount = await prisma.application.count({ where: { categoryId: id } });
    if (appsCount > 0) {
      return res.status(400).json({ error: 'Cannot delete this category because there are applications tied to it.' });
    }

    await prisma.membershipCategory.delete({ where: { id } });

    return res.status(200).json({ message: 'Category deleted successfully.' });
  } catch (error: any) {
    console.error('[Delete Category] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error deleting category.' });
  }
}
