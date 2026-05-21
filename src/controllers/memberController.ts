import { Request, Response } from 'express';
import { pool } from '../config/db';

export async function getPublicMembersDirectory(req: Request, res: Response) {
  try {
    const { search, category, page = 1, limit = 10 } = req.query;

    let queryStr = `
      SELECT id, full_name, membership_class, phone_number, email
      FROM members
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (search) {
      queryStr += ` AND (full_name ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    if (category && category !== 'all') {
      queryStr += ` AND membership_class = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    // Pagination
    const offset = (Number(page) - 1) * Number(limit);
    queryStr += ` ORDER BY full_name ASC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(Number(limit), offset);

    const result = await pool.query(queryStr, params);

    // Get total count for pagination
    let countQueryStr = `SELECT COUNT(*) FROM members WHERE 1=1`;
    const countParams: any[] = [];
    let countParamIndex = 1;
    if (search) {
      countQueryStr += ` AND (full_name ILIKE $${countParamIndex} OR email ILIKE $${countParamIndex})`;
      countParams.push(`%${search}%`);
      countParamIndex++;
    }
    if (category && category !== 'all') {
      countQueryStr += ` AND membership_class = $${countParamIndex}`;
      countParams.push(category);
    }
    const countResult = await pool.query(countQueryStr, countParams);
    const totalCount = parseInt(countResult.rows[0].count, 10);

    return res.status(200).json({
      members: result.rows,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        totalCount,
        totalPages: Math.ceil(totalCount / Number(limit))
      }
    });

  } catch (error: any) {
    console.error('[Member Controller] Error fetching directory:', error.message);
    return res.status(500).json({ error: 'Internal server error while fetching members directory.' });
  }
}
