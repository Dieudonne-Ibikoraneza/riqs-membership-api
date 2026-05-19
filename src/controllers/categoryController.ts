import { Request, Response } from 'express';
import { pool } from '../config/db';

// 1. Fetch all membership categories (public — needed by frontend registration wizard)
export async function getAllCategories(req: Request, res: Response) {
  try {
    const { location, entityType } = req.query;
    let query = 'SELECT * FROM membership_categories';
    const params: any[] = [];
    const conditions: string[] = [];

    if (location) {
      conditions.push(`location = $${params.length + 1}`);
      params.push(location);
    }
    if (entityType) {
      conditions.push(`entity_type = $${params.length + 1}`);
      params.push(entityType);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY location, entity_type, category_name';

    const result = await pool.query(query, params);
    return res.status(200).json({ categories: result.rows });
  } catch (error: any) {
    console.error('[Get Categories] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching membership categories.' });
  }
}

// 2. Fetch a single category by ID
export async function getCategoryById(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM membership_categories WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Membership category not found.' });
    }

    return res.status(200).json({ category: result.rows[0] });
  } catch (error: any) {
    console.error('[Get Category By ID] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching category details.' });
  }
}
