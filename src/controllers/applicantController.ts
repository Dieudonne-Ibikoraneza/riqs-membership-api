import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';
import { PracticeLocation, EntityType } from '@prisma/client';

// 1. Fetch complete application packet (including educations, documents, mentorships, and shareholders)
export async function getApplication(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  try {
    const app = await prisma.application.findFirst({
      where: { memberId: req.user.id },
      include: {
        category: {
          select: {
            categoryName: true,
            processingFee: true,
            firstYearFee: true,
            annualRenewalFee: true
          }
        },
        educationRecords: true,
        employmentRecords: { orderBy: { startDate: 'desc' } },
        firmShareholders: true,
        mentorshipAssignment: true,
        uploadedDocuments: {
          select: {
            id: true,
            documentType: true,
            fileName: true,
            uploadedAt: true
          }
        },
        member: {
          select: {
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
            membershipClass: true,
            membershipId: true
          }
        }
      }
    });

    if (!app) {
      const member = await prisma.member.findUnique({
        where: { id: req.user.id },
        select: {
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
          membershipClass: true,
          membershipId: true
        }
      });
      return res.status(200).json({ profile: member, application: null, message: 'No active application draft found for this member.' });
    }

    const formattedApplication = {
      ...app,
      category_name: app.category.categoryName,
      processing_fee: app.category.processingFee,
      first_year_fee: app.category.firstYearFee,
      annual_renewal_fee: app.category.annualRenewalFee,
      category: undefined,
      educationRecords: undefined,
      employmentRecords: undefined,
      firmShareholders: undefined,
      mentorshipAssignment: undefined,
      uploadedDocuments: undefined,
      member: undefined
    };

    let formattedMentorship = undefined;
    if (app.mentorshipAssignment) {
      formattedMentorship = {
        ...app.mentorshipAssignment,
        options: app.mentorshipAssignment.preferredMentors || [],
        preferredMentors: undefined,
        isSelfAssigned: undefined,
        requestedInstitutionalAssignment: undefined,
        preferredPracticeAreas: undefined
      };
    }

    const memberProfile = app.member;

    return res.status(200).json({
      profile: memberProfile,
      application: formattedApplication,
      education: app.educationRecords,
      employment: app.employmentRecords,
      shareholders: app.firmShareholders,
      mentorship: formattedMentorship,
      documents: app.uploadedDocuments
    });
  } catch (error: any) {
    console.error('[Get Application] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while fetching application details.' });
  }
}

// 2. Upsert Application (Draft Auto-Saver & Phase B Lock Policy Enforcer)
export async function createOrUpdateApplication(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  const {
    practiceLocation,
    entityType,
    categoryId,
    fullName,
    phoneNumber,
    dob,
    gender,
    nationality,
    nationalIdOrPassport,
    residencyAddress,
    workAddress,
    yearsInProfession,
    countryOfOrigin
  } = req.body;

  if (!practiceLocation || !entityType || !categoryId) {
    return res.status(400).json({ error: 'Missing mandatory registration classifiers: location, entity type, and category.' });
  }

  try {
    const existingApp = await prisma.application.findFirst({
      where: { memberId: req.user.id }
    });

    // Update member profile fields
    const memberUpdateData: any = { updatedAt: new Date() };
    if (fullName) memberUpdateData.fullName = fullName;
    if (phoneNumber) memberUpdateData.phoneNumber = phoneNumber;
    if (dob) memberUpdateData.dateOfBirth = new Date(dob);
    if (gender) memberUpdateData.gender = gender;
    if (nationality) memberUpdateData.nationality = nationality;
    if (nationalIdOrPassport) memberUpdateData.nationalIdOrPassport = nationalIdOrPassport;
    if (residencyAddress) memberUpdateData.residencyAddress = residencyAddress;
    if (workAddress) memberUpdateData.workAddress = workAddress;
    if (yearsInProfession !== undefined && yearsInProfession !== null && yearsInProfession !== '') {
      memberUpdateData.yearsInProfession = parseInt(String(yearsInProfession), 10);
    }
    if (countryOfOrigin) memberUpdateData.countryOfOrigin = countryOfOrigin;

    await prisma.member.update({
      where: { id: req.user.id },
      data: memberUpdateData
    });

    if (existingApp) {
      if (existingApp.status === 'Approved') {
        if (
          existingApp.practiceLocation !== practiceLocation ||
          existingApp.entityType !== entityType ||
          existingApp.categoryId !== categoryId
        ) {
          return res.status(400).json({ error: 'Compliance Lock Violation: You cannot alter registration categories or entity scopes post-approval.' });
        }
      }

      const transactions: any[] = [
        prisma.application.update({
          where: { id: existingApp.id },
          data: {
            practiceLocation: practiceLocation as PracticeLocation,
            entityType: entityType as EntityType,
            categoryId,
            updatedAt: new Date()
          }
        })
      ];

      if (existingApp.status === 'Approved') {
        transactions.push(
          prisma.auditLog.create({
            data: {
              memberId: req.user.id,
              actionByEmail: req.user.email,
              actionType: 'PHASE_B_EDIT',
              details: 'Approved member updated dynamic employer profile records.'
            }
          })
        );
      }

      const [updatedApp] = await prisma.$transaction(transactions);

      return res.status(200).json({ 
        message: 'Application draft successfully auto-saved.', 
        application: updatedApp 
      });
    }

    // Create fresh Application Draft
    const newApp = await prisma.application.create({
      data: {
        memberId: req.user.id,
        practiceLocation: practiceLocation as PracticeLocation,
        entityType: entityType as EntityType,
        categoryId,
        status: 'Draft'
      }
    });

    return res.status(201).json({ 
      message: 'Application initialized as Draft.', 
      application: newApp 
    });
  } catch (error: any) {
    console.error('[Upsert Application] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error auto-saving application draft.' });
  }
}

// 3. Upsert Shareholders - Bulk loads and checks for 100.00% exact shareholdings
export async function upsertShareholders(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  const { applicationId, shareholders } = req.body;
  if (!applicationId || !Array.isArray(shareholders) || shareholders.length === 0) {
    return res.status(400).json({ error: 'Missing applicationId or invalid shareholders payload list.' });
  }

  let totalShares = 0;
  for (const s of shareholders) {
    const percentage = parseFloat(s.shareholdingPercentage);
    if (isNaN(percentage) || percentage <= 0 || percentage > 100) {
      return res.status(400).json({ error: 'Invalid shareholding percentage. Percentage per partner must be between 0% and 100%.' });
    }
    totalShares += percentage;
  }

  const roundedSum = Math.round(totalShares * 100) / 100;
  if (roundedSum !== 100.00) {
    return res.status(400).json({
      error: `Compliance Validation Violation: Total firm shareholding must sum to exactly 100.00%. Sum currently calculated: ${roundedSum}%`
    });
  }

  try {
    const creationData = shareholders.map(s => ({
      applicationId,
      fullName: s.fullName,
      email: s.email,
      phoneNumber: s.phoneNumber,
      citizenship: s.citizenship || 'Rwandan',
      shareholdingPercentage: s.shareholdingPercentage,
      riqsMembershipId: s.riqsMembershipId || null
    }));

    await prisma.$transaction([
      prisma.firmShareholder.deleteMany({
        where: { applicationId }
      }),
      prisma.firmShareholder.createMany({
        data: creationData
      })
    ]);

    return res.status(200).json({ message: 'Firm shareholder percentages successfully verified and locked.' });
  } catch (error: any) {
    console.error('[Upsert Shareholders] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error while verifying shareholder records.' });
  }
}

// 4. Submit Application - Finalizes and locks Phase A drafts, entering the Reviewer Queue
export async function submitApplication(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied. Authenticated session required.' });

  const { applicationId } = req.body;
  if (!applicationId) {
    return res.status(400).json({ error: 'Missing applicationId in submission request.' });
  }

  try {
    const existingApp = await prisma.application.findFirst({
      where: {
        id: applicationId,
        memberId: req.user.id,
        status: { in: ['Draft', 'Correction_Required'] }
      }
    });

    if (!existingApp) {
      return res.status(400).json({ error: 'Invalid submission request. Application is not in Draft or Correction state.' });
    }

    // Mentor Auto-Assignment Logic
    const mentorship = await prisma.mentorshipAssignment.findUnique({
      where: { applicationId }
    });

    if (mentorship) {
      let assignedMentor: any = null;

      // 1. Check preferred mentors if provided
      if (mentorship.preferredMentors && Array.isArray(mentorship.preferredMentors)) {
        for (const pref of mentorship.preferredMentors as any[]) {
          if (pref.regNumber) {
            const currentLoad = await prisma.mentorshipAssignment.count({
              where: { mentorRegistrationNumber: pref.regNumber }
            });
            if (currentLoad < 5) {
              assignedMentor = {
                regNumber: pref.regNumber,
                name: pref.name || null,
                contact: pref.contact || null
              };
              break;
            }
          }
        }
      }

      // 2. Fallback: Auto-assign if no preferences were available
      if (!assignedMentor) {
        const potentialMentors = await prisma.member.findMany({
          where: { systemRole: 'Mentor', membershipId: { not: null } }
        });

        for (const mentor of potentialMentors) {
          const currentLoad = await prisma.mentorshipAssignment.count({
            where: { mentorRegistrationNumber: mentor.membershipId }
          });
          if (currentLoad < 5) {
            assignedMentor = {
              regNumber: mentor.membershipId,
              name: mentor.fullName,
              contact: mentor.phoneNumber || mentor.email
            };
            break;
          }
        }
      }

      // Update mentorship record with final assignment
      if (assignedMentor) {
        await prisma.mentorshipAssignment.update({
          where: { id: mentorship.id },
          data: {
            mentorRegistrationNumber: assignedMentor.regNumber,
            mentorName: assignedMentor.name,
            mentorContact: assignedMentor.contact
          }
        });
      }
    }

    const updatedApp = await prisma.application.update({
      where: { id: applicationId },
      data: {
        status: 'Pending',
        submittedAt: new Date(),
        updatedAt: new Date()
      }
    });

    return res.status(200).json({
      message: 'Application locked and successfully submitted to review queue.',
      application: updatedApp
    });
  } catch (error: any) {
    console.error('[Submit Application] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error locking application.' });
  }
}
