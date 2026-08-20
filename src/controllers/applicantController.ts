import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';
import { PracticeLocation, EntityType } from '@prisma/client';
import { sendMail } from '../config/mailer';

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
            annualRenewalFee: true,
            requiredDocuments: true,
            optionalDocuments: true
          }
        },
        educationRecords: true,
        employmentRecords: { orderBy: { startDate: 'desc' } },
        studentAssociation: true,
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
        statusHistory: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          where: { newStatus: 'Correction_Required' },
          select: { reviewerNotes: true }
        },
        financialTransactions: {
          orderBy: { createdAt: 'desc' }
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
            membershipId: true,
            profilePhotoUrl: true,
            membershipExpiresAt: true,
            systemRole: true,
            isFellow: true,
            isHonorary: true,
            honors: true
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
          membershipId: true,
          membershipExpiresAt: true,
          systemRole: true,
          isFellow: true,
          isHonorary: true,
          honors: true
        }
      });
      return res.status(200).json({ profile: member, application: null, message: 'No active application draft found for this member.' });
    }

    let currentCategory = null;
    if (app.member?.membershipClass) {
      currentCategory = await prisma.membershipCategory.findFirst({
        where: { categoryName: app.member.membershipClass }
      });
    }

    const formattedApplication = {
      ...app,
      category_name: currentCategory?.categoryName || app.category.categoryName,
      processing_fee: currentCategory?.processingFee || app.category.processingFee,
      first_year_fee: currentCategory?.firstYearFee || app.category.firstYearFee,
      annual_renewal_fee: currentCategory?.annualRenewalFee || app.category.annualRenewalFee,
      reviewerNotes: app.status === 'Correction_Required' && app.statusHistory?.length > 0 ? app.statusHistory[0].reviewerNotes : null,
      category: undefined,
      educationRecords: undefined,
      employmentRecords: undefined,
      studentAssociation: undefined,
      firmShareholders: undefined,
      mentorshipAssignment: undefined,
      uploadedDocuments: undefined,
      statusHistory: undefined,
      financialTransactions: undefined,
      member: undefined
    };

    let formattedMentorship = undefined;
    if (app.mentorshipAssignment) {
      formattedMentorship = {
        ...app.mentorshipAssignment,
        options: app.mentorshipAssignment.preferredMentors || [],
        preferredMentors: undefined
      };
    }

    const memberProfile = app.member;

    const categoryDocs = [
      ...(Array.isArray(app.category.requiredDocuments) ? app.category.requiredDocuments as any[] : []),
      ...(Array.isArray(app.category.optionalDocuments) ? app.category.optionalDocuments as any[] : [])
    ];

    const typeCounts: Record<string, number> = {};
    const categoryDocsWithUid = categoryDocs.map(doc => {
      const base = doc.typeCode || (doc.name ? doc.name.toLowerCase().replace(/[^a-z0-9]/g, "_") : "unknown");
      typeCounts[base] = (typeCounts[base] || 0) + 1;
      const uid = typeCounts[base] > 1 ? `${base}_${typeCounts[base]}` : base;
      return { ...doc, uid };
    });

    const mappedDocuments = app.uploadedDocuments.map((doc: any) => {
      let docName = doc.documentType;
      const matched = categoryDocsWithUid.find(c => c.uid === doc.documentType);
      if (matched && matched.name) {
        docName = matched.name;
      }
      return {
        ...doc,
        documentName: docName
      };
    });

    return res.status(200).json({
      profile: memberProfile,
      application: formattedApplication,
      education: app.educationRecords,
      employment: app.employmentRecords,
      studentAssociation: app.studentAssociation,
      shareholders: app.firmShareholders,
      mentorship: formattedMentorship,
      documents: mappedDocuments,
      financialTransactions: app.financialTransactions
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
    countryOfOrigin,
    firmName,
    firmAddress,
    firmContactRegistrationNumber,
    firmContactResidence,
    firmMainBusinessActivity,
    firmCountryOfIncorporation,
    firmPrincipalPlaceOfBusiness,
    agreedToMentorshipIntent,
    hasNoEmployment,
    agreedToDeclarations,
    competenceSummary,
    studentAssociation,
    currentStep
  } = req.body;

  if (!practiceLocation || !entityType || !categoryId) {
    return res.status(400).json({ error: 'Missing mandatory registration classifiers: location, entity type, and category.' });
  }

  try {
    if (entityType === 'Individual') {
      const category = await prisma.membershipCategory.findUnique({ where: { id: categoryId } });
      if (!category || !['GradQST', 'GradQS', 'GrQST', 'GrQS'].includes(category.categoryCode)) {
        return res.status(400).json({ error: 'Individual applications are currently accepted only for Graduate QS or Graduate QS Technologist.' });
      }
    }

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
            firmName,
            firmAddress,
            firmContactRegistrationNumber,
            firmContactResidence,
            firmMainBusinessActivity,
            firmCountryOfIncorporation,
            firmPrincipalPlaceOfBusiness,
            agreedToMentorshipIntent: agreedToMentorshipIntent ?? existingApp.agreedToMentorshipIntent,
            hasNoEmployment: hasNoEmployment ?? existingApp.hasNoEmployment,
            agreedToDeclarations: agreedToDeclarations ?? existingApp.agreedToDeclarations,
            competenceSummary: competenceSummary ?? existingApp.competenceSummary,
            currentStep: currentStep !== undefined ? currentStep : existingApp.currentStep,
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

      if (studentAssociation && studentAssociation.associationName) {
        transactions.push(
          prisma.studentAssociationRecord.upsert({
            where: { applicationId: existingApp.id },
            update: {
              associationName: studentAssociation.associationName,
              membershipNumber: studentAssociation.membershipNumber,
              registrationDate: new Date(studentAssociation.registrationDate),
              activeYears: parseInt(String(studentAssociation.activeYears), 10) || 0
            },
            create: {
              applicationId: existingApp.id,
              associationName: studentAssociation.associationName,
              membershipNumber: studentAssociation.membershipNumber,
              registrationDate: new Date(studentAssociation.registrationDate),
              activeYears: parseInt(String(studentAssociation.activeYears), 10) || 0
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
        firmName,
        firmAddress,
        firmContactRegistrationNumber,
        firmContactResidence,
        firmMainBusinessActivity,
        firmCountryOfIncorporation,
        firmPrincipalPlaceOfBusiness,
        agreedToMentorshipIntent: agreedToMentorshipIntent || false,
        hasNoEmployment: hasNoEmployment || false,
        agreedToDeclarations: agreedToDeclarations || false,
        competenceSummary: competenceSummary || null,
        currentStep: currentStep || 0,
        status: 'Draft'
      }
    });

    if (studentAssociation && studentAssociation.associationName) {
      await prisma.studentAssociationRecord.create({
        data: {
          applicationId: newApp.id,
          associationName: studentAssociation.associationName,
          membershipNumber: studentAssociation.membershipNumber,
          registrationDate: new Date(studentAssociation.registrationDate),
          activeYears: parseInt(String(studentAssociation.activeYears), 10) || 0
        }
      });
    }

    return res.status(201).json({ 
      message: 'Application initialized as Draft.', 
      application: newApp 
    });
  } catch (error: any) {
    console.error('[Upsert Application] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error auto-saving application draft.' });
  }
}

// 3. Upsert Student Association
export async function upsertStudentAssociation(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Access Denied.' });

  const { applicationId, associationName, membershipNumber, registrationDate, activeYears } = req.body;
  if (!applicationId || !associationName || !membershipNumber || !registrationDate || activeYears === undefined) {
    return res.status(400).json({ error: 'Missing student association parameters.' });
  }

  try {
    const record = await prisma.studentAssociationRecord.upsert({
      where: { applicationId },
      update: {
        associationName,
        membershipNumber,
        registrationDate: new Date(registrationDate),
        activeYears: parseInt(activeYears, 10)
      },
      create: {
        applicationId,
        associationName,
        membershipNumber,
        registrationDate: new Date(registrationDate),
        activeYears: parseInt(activeYears, 10)
      }
    });
    return res.status(200).json({ message: 'Student association saved', studentAssociation: record });
  } catch (error: any) {
    console.error('[Upsert Student Association] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error saving student association.' });
  }
}

// 4. Upsert Shareholders - Bulk loads and checks for 100.00% exact shareholdings
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
  if (roundedSum < 99.9 || roundedSum > 100.1) {
    return res.status(400).json({
      error: `Compliance Validation Violation: Total firm shareholding must sum to around 100%. Sum currently calculated: ${roundedSum}%`
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

  const applicantUserId = req.user.id;
  const applicantUserEmail = req.user.email;

  try {
    const existingApp = await prisma.application.findFirst({
      where: {
        id: applicationId,
        memberId: req.user.id,
        status: { in: ['Draft', 'Correction_Required'] }
      },
      include: {
        category: true,
        member: { select: { fullName: true, email: true } }
      }
    });

    if (!existingApp) {
      return res.status(400).json({ error: 'Invalid submission request. Application is not in Draft or Correction state.' });
    }

    // Mentor Auto-Assignment Logic
    let mentorship = await prisma.mentorshipAssignment.findUnique({
      where: { applicationId }
    });

    // If it's a Graduate application and they didn't provide a mentorship plan, create an empty one
    const isGraduate = existingApp.category && existingApp.entityType === 'Individual' && existingApp.category.categoryName.toLowerCase().includes('graduate');
    if (!mentorship && isGraduate) {
      mentorship = await prisma.mentorshipAssignment.create({
        data: { applicationId, preferredMentors: [], isSelfAssigned: false, requestedInstitutionalAssignment: true }
      });
    }

      if (mentorship) {
        let assignedMentor: any = null;
        let wasPreferredMentorAssigned = false;
  
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
                wasPreferredMentorAssigned = true;
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
              mentorContact: assignedMentor.contact,
              isSelfAssigned: wasPreferredMentorAssigned
            }
          });
        }
    }

    const isRoute3Or4 = existingApp.category && 
      (existingApp.category.categoryName.toLowerCase().includes('route 3') || 
       existingApp.category.categoryName.toLowerCase().includes('route 4') ||
       existingApp.category.categoryCode === 'QST' ||
       existingApp.category.categoryCode === 'PQS');

    // Route 3/4 Fee Bypass Logic
    if (isRoute3Or4) {
      const existingFee = await prisma.financialTransaction.findFirst({
        where: { applicationId, txType: 'Processing_Fee' }
      });
      if (!existingFee) {
        await prisma.financialTransaction.create({
          data: {
            memberId: existingApp.memberId,
            applicationId: applicationId,
            amount: 0,
            currency: 'RWF',
            txType: 'Processing_Fee',
            paymentMethod: 'Bank_Transfer',
            transactionReference: `AUTO-WAIVED-${Date.now()}`,
            status: 'Cleared'
          }
        });
      }
    }

    const wasReturnedForCorrection = existingApp.status === 'Correction_Required';
    const submissionStatus = wasReturnedForCorrection ? 'Under_Review' : 'Pending';
    const submissionTime = new Date();

    const updatedApp = await prisma.$transaction(async (tx) => {
      const updated = await tx.application.update({
        where: { id: applicationId },
        data: {
          // Fresh applications go to the front-desk queue. Corrected
          // applications return directly to the reviewer committee.
          status: submissionStatus,
          submittedAt: submissionTime,
          updatedAt: submissionTime
        }
      });

      if (wasReturnedForCorrection) {
        // A correction starts a new review round; previous reviewer notes
        // must not count toward the new assessment.
        await tx.applicationReview.deleteMany({ where: { applicationId } });
      }

      await tx.applicationStatusHistory.create({
        data: {
          applicationId,
          changedByEmail: applicantUserEmail,
          oldStatus: existingApp.status,
          newStatus: submissionStatus,
          reviewerNotes: null
        }
      });

      await tx.auditLog.create({
        data: {
          memberId: applicantUserId,
          actionByEmail: applicantUserEmail,
          actionType: wasReturnedForCorrection
            ? 'APPLICATION_RESUBMITTED_TO_REVIEWERS'
            : 'APPLICATION_SUBMITTED',
          details: wasReturnedForCorrection
            ? `Corrected application resubmitted directly to the reviewer committee for category: ${existingApp.category?.categoryName || 'Unknown'}.`
            : `Application submitted for category: ${existingApp.category?.categoryName || 'Unknown'}.`
        }
      });

      return updated;
    });

    const notificationTemplate = wasReturnedForCorrection
      ? 'applicationResubmitted'
      : 'applicationSubmitted';
      try {
        await sendMail(applicantUserEmail, notificationTemplate, {
        name: existingApp.member?.fullName || applicantUserEmail,
      });
    } catch (mailErr: any) {
      console.warn(`[Submit Application] ${notificationTemplate} email failed:`, mailErr.message);
    }

    return res.status(200).json({
      message: wasReturnedForCorrection
        ? 'Corrected application resubmitted directly to the reviewer committee.'
        : 'Application locked and successfully submitted to review queue.',
      application: updatedApp
    });
  } catch (error: any) {
    console.error('[Submit Application] Error:', error.message);
    return res.status(500).json({ error: 'Internal server error locking application.' });
  }
}
