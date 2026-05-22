import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { MemberClass } from '@prisma/client';

export async function getPublicMembersDirectory(req: Request, res: Response) {
  try {
    const { search, category, page = 1, limit = 10 } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const whereClause: any = {};

    if (search) {
      whereClause.OR = [
        { fullName: { contains: search as string, mode: 'insensitive' } },
        { email: { contains: search as string, mode: 'insensitive' } }
      ];
    }

    if (category && category !== 'all') {
      whereClause.membershipClass = category as MemberClass;
    }

    const [members, totalCount] = await Promise.all([
      prisma.member.findMany({
        where: whereClause,
        skip,
        take,
        orderBy: { fullName: 'asc' },
        select: {
          id: true,
          fullName: true,
          membershipClass: true,
          phoneNumber: true,
          email: true
        }
      }),
      prisma.member.count({ where: whereClause })
    ]);

    // Format for existing UI mapping (converting camelCase to snake_case equivalent)
    const formattedMembers = members.map(m => ({
      id: m.id,
      full_name: m.fullName,
      membership_class: m.membershipClass,
      phone_number: m.phoneNumber,
      email: m.email
    }));

    return res.status(200).json({
      members: formattedMembers,
      pagination: {
        page: Number(page),
        limit: take,
        totalCount,
        totalPages: Math.ceil(totalCount / take)
      }
    });

  } catch (error: any) {
    console.error('[Member Controller] Error fetching directory:', error.message);
    return res.status(500).json({ error: 'Internal server error while fetching members directory.' });
  }
}
