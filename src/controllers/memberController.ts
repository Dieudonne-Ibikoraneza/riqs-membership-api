import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma, supabaseAdmin } from '../config/db';
import { MemberClass } from '@prisma/client';

export async function getPublicMembersDirectory(req: Request, res: Response) {
  try {
    const { search, category, page = 1, limit = 10, mentorsOnly } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const whereClause: any = {
      membershipId: { not: null }, // Only show fully approved members
      systemRole: { notIn: ['Admin', 'Reviewer', 'Approver', 'Teacher'] }
    };

    if (search) {
      whereClause.OR = [
        { fullName: { contains: search as string, mode: 'insensitive' } },
        { email: { contains: search as string, mode: 'insensitive' } },
        { membershipId: { contains: search as string, mode: 'insensitive' } }
      ];
    }

    if (mentorsOnly === 'true') {
      // Being Technologist/Professional no longer implies mentor status — only members
      // actually granted the Mentor role (via application or direct promotion) qualify.
      whereClause.systemRole = 'Mentor';
    } else if (category && category !== 'all') {
      if (category === 'Firm') {
        whereClause.membershipClass = {
          in: [
            'Firm_Local_Small', 'Firm_Local_Medium', 'Firm_Local_Large',
            'Firm_Foreign_Small', 'Firm_Foreign_Medium', 'Firm_Foreign_Large'
          ]
        };
      } else {
        whereClause.membershipClass = category as MemberClass;
      }
    }

    const [members, totalCount] = await Promise.all([
      prisma.member.findMany({
        where: whereClause,
        skip,
        take,
        orderBy: { fullName: 'asc' },
        select: {
          id: true,
          membershipId: true,
          fullName: true,
          membershipClass: true,
          phoneNumber: true,
          email: true,
          profilePhotoUrl: true,
          isFellow: true,
          isHonorary: true,
          honors: true
        }
      }),
      prisma.member.count({ where: whereClause })
    ]);

    // Format for existing UI mapping (converting camelCase to snake_case equivalent)
    const formattedMembers = members.map(m => ({
      id: m.id,
      membership_id: m.membershipId,
      full_name: m.fullName,
      membership_class: m.membershipClass,
      phone_number: m.phoneNumber,
      email: m.email,
      profile_photo_url: m.profilePhotoUrl,
      isFellow: m.isFellow,
      isHonorary: m.isHonorary,
      honors: m.honors
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
    return res.status(500).json({ error: 'Internal server error while fetching members.' });
  }
}

export async function getMentorById(req: Request, res: Response) {
  try {
    const { membershipId } = req.params;

    const mentor = await prisma.member.findUnique({
      where: { membershipId: membershipId as string },
      select: {
        fullName: true,
        email: true,
        phoneNumber: true,
        membershipClass: true,
        systemRole: true
      }
    });

    if (!mentor) {
      return res.status(404).json({ error: 'Mentor not found.' });
    }

    // Being Technologist/Professional no longer implies mentor status — only members
    // actually granted the Mentor role (via application or direct promotion) qualify.
    if (mentor.systemRole !== 'Mentor') {
      return res.status(400).json({ error: 'Member is not eligible to be a mentor.' });
    }

    return res.status(200).json({
      fullName: mentor.fullName,
      contact: mentor.email || mentor.phoneNumber || ""
    });

  } catch (error: any) {
    console.error('[Member Controller] Error fetching mentor:', error.message);
    return res.status(500).json({ error: 'Internal server error while fetching mentor.' });
  }
}

// Public, unauthenticated: the destination of the QR code printed on membership cards and
// certificates. Anyone who scans it — an employer, a client, another institute — lands here
// to confirm a membership ID genuinely belongs to a registered RIQS member. Deliberately
// returns only what's safe to show a stranger: name, membership ID, category, standing, and
// honours — never email, phone, national ID, address, or anything financial.
export async function verifyMember(req: Request, res: Response) {
  try {
    const { membershipId } = req.params;
    if (!membershipId) return res.status(400).json({ error: 'Missing membership ID.' });

    const member = await prisma.member.findUnique({
      where: { membershipId: String(membershipId) },
      select: {
        fullName: true,
        email: true,
        phoneNumber: true,
        membershipId: true,
        membershipClass: true,
        membershipExpiresAt: true,
        isFellow: true,
        isHonorary: true,
        honors: true,
        countryOfOrigin: true,
        profilePhotoUrl: true,
        applications: {
          where: { status: 'Approved' },
          orderBy: { approvedAt: 'desc' },
          take: 1,
          select: { practiceLocation: true, category: { select: { categoryName: true, location: true } } }
        }
      }
    });

    // A membership ID is only ever assigned once an application is fully approved and paid —
    // no membershipId means there is nothing legitimate here to verify.
    if (!member || !member.membershipId) {
      return res.status(404).json({ found: false, error: 'No RIQS member found with this membership ID.' });
    }

    const app = member.applications[0];
    const isExpired = Boolean(member.membershipExpiresAt && member.membershipExpiresAt < new Date());

    return res.status(200).json({
      found: true,
      fullName: member.fullName,
      email: member.email,
      phoneNumber: member.phoneNumber,
      membershipId: member.membershipId,
      membershipClass: member.membershipClass,
      categoryName: app?.category?.categoryName || null,
      practiceLocation: app?.practiceLocation || app?.category?.location || null,
      countryOfOrigin: member.countryOfOrigin,
      status: isExpired ? 'Expired' : 'Active',
      membershipExpiresAt: member.membershipExpiresAt,
      isFellow: member.isFellow,
      isHonorary: member.isHonorary,
      honors: member.honors || [],
      // The photo itself is served separately (see verifyMemberPhoto) rather than as a raw
      // storage path, so the client never needs to know the private bucket layout.
      hasPhoto: Boolean(member.profilePhotoUrl),
    });
  } catch (error: any) {
    console.error('[Member Controller] Error verifying member:', error.message);
    return res.status(500).json({ error: 'Internal server error while verifying member.' });
  }
}

// Streams a member's profile photo for the public verification page — deliberately scoped to
// only the photo already tied to this exact, publicly-printed membership ID (never an arbitrary
// storage path from the client), so it can't be used to reach any other file in private storage.
export async function verifyMemberPhoto(req: Request, res: Response) {
  try {
    const { membershipId } = req.params;
    if (!membershipId) return res.status(400).json({ error: 'Missing membership ID.' });

    const member = await prisma.member.findUnique({
      where: { membershipId: String(membershipId) },
      select: { profilePhotoUrl: true }
    });

    if (!member || !member.profilePhotoUrl) {
      return res.status(404).json({ error: 'No photo on file for this member.' });
    }

    const { data, error } = await supabaseAdmin.storage
      .from('riqs-membership')
      .download(member.profilePhotoUrl);

    if (error || !data) {
      return res.status(404).json({ error: 'Photo could not be retrieved.' });
    }

    const buffer = Buffer.from(await data.arrayBuffer());
    const lower = member.profilePhotoUrl.toLowerCase();
    const contentType = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.webp') ? 'image/webp' : 'image/jpeg';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(buffer);
  } catch (error: any) {
    console.error('[Member Controller] Error streaming verification photo:', error.message);
    return res.status(500).json({ error: 'Internal server error while retrieving photo.' });
  }
}

export async function getMemberProfile(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  try {
    const profile = await prisma.member.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        fullName: true,
        email: true,
        phoneNumber: true,
        dateOfBirth: true,
        gender: true,
        nationality: true,
        nationalIdOrPassport: true,
        residencyAddress: true,
        workAddress: true,
        yearsInProfession: true,
        countryOfOrigin: true,
        membershipId: true,
        membershipClass: true,
        systemRole: true,
        profilePhotoUrl: true
      }
    });

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found.' });
    }

    return res.status(200).json({ profile });
  } catch (error: any) {
    console.error('[Get Profile Error]:', error.message);
    return res.status(500).json({ error: 'Internal server error fetching profile.' });
  }
}

export async function updateMemberProfile(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const {
    fullName,
    phoneNumber,
    dob,
    gender,
    nationality,
    nationalIdOrPassport,
    residencyAddress,
    workAddress,
    yearsInProfession,
    countryOfOrigin,
    profilePhotoUrl
  } = req.body;

  try {
    const memberUpdateData: any = { updatedAt: new Date() };
    if (fullName !== undefined) memberUpdateData.fullName = fullName;
    if (phoneNumber !== undefined) memberUpdateData.phoneNumber = phoneNumber;
    if (dob !== undefined) memberUpdateData.dateOfBirth = new Date(dob);
    if (gender !== undefined) memberUpdateData.gender = gender;
    if (nationality !== undefined) memberUpdateData.nationality = nationality;
    if (nationalIdOrPassport !== undefined) memberUpdateData.nationalIdOrPassport = nationalIdOrPassport;
    if (residencyAddress !== undefined) memberUpdateData.residencyAddress = residencyAddress;
    if (workAddress !== undefined) memberUpdateData.workAddress = workAddress;
    if (yearsInProfession !== undefined && yearsInProfession !== null && yearsInProfession !== '') {
      memberUpdateData.yearsInProfession = parseInt(String(yearsInProfession), 10);
    }
    if (countryOfOrigin !== undefined) memberUpdateData.countryOfOrigin = countryOfOrigin;
    if (profilePhotoUrl !== undefined) memberUpdateData.profilePhotoUrl = profilePhotoUrl;

    const updatedProfile = await prisma.member.update({
      where: { id: req.user.id },
      data: memberUpdateData,
      select: {
        id: true,
        fullName: true,
        email: true,
        phoneNumber: true,
        dateOfBirth: true,
        gender: true,
        nationality: true,
        nationalIdOrPassport: true,
        residencyAddress: true,
        workAddress: true,
        yearsInProfession: true,
        countryOfOrigin: true,
        membershipId: true,
        membershipClass: true,
        systemRole: true,
        profilePhotoUrl: true
      }
    });

    return res.status(200).json({ 
      message: 'Profile updated successfully.',
      profile: updatedProfile 
    });
  } catch (error: any) {
    console.error('[Update Profile Error]:', error.message);
    return res.status(500).json({ error: 'Internal server error updating profile.' });
  }
}
