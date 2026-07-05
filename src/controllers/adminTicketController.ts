import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';
import { emitTicketReply } from '../config/socket';

// Get all support tickets (admin view)
export async function getAdminTickets(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { status, priority, q, page = 1, limit = 10 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);
  const take = Number(limit);

  let whereClause: any = {};
  
  if (status && status !== 'all') whereClause.status = String(status);
  if (priority && priority !== 'all') whereClause.priority = String(priority);
  
  if (q) {
    const search = String(q);
    whereClause.OR = [
      { subject: { contains: search, mode: 'insensitive' } },
      { member: { fullName: { contains: search, mode: 'insensitive' } } },
      { member: { email: { contains: search, mode: 'insensitive' } } }
    ];
  }

  try {
    const [tickets, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where: whereClause,
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
        include: {
          member: {
            select: { id: true, fullName: true, email: true, membershipId: true, profilePhotoUrl: true }
          },
          _count: { select: { replies: true } }
        }
      }),
      prisma.supportTicket.count({ where: whereClause })
    ]);

    return res.status(200).json({
      tickets,
      pagination: {
        total,
        page: Number(page),
        limit: take,
        pages: Math.ceil(total / take)
      }
    });
  } catch (error: any) {
    console.error('[Get Admin Tickets Error]', error.message);
    return res.status(500).json({ error: 'Internal server error while fetching tickets.' });
  }
}

// Get single ticket details
export async function getAdminTicketDetails(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    const ticket = await prisma.supportTicket.findUnique({
      where: { id },
      include: {
        member: {
          select: { id: true, fullName: true, email: true, membershipId: true, profilePhotoUrl: true }
        },
        replies: {
          orderBy: { createdAt: 'asc' },
          include: {
            sender: {
              select: { id: true, fullName: true, systemRole: true, profilePhotoUrl: true }
            }
          }
        }
      }
    });

    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

    return res.status(200).json({ ticket });
  } catch (error: any) {
    console.error('[Get Admin Ticket Details Error]', error.message);
    return res.status(500).json({ error: 'Internal server error while fetching ticket details.' });
  }
}

// Admin reply to ticket
export async function adminReplyToTicket(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const { message } = req.body;

  if (!message) return res.status(400).json({ error: 'Reply message cannot be empty.' });

  try {
    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

    const reply = await prisma.ticketReply.create({
      data: {
        ticketId: id,
        senderId: req.user.id,
        message
      },
      include: {
        sender: {
          select: { id: true, fullName: true, systemRole: true, profilePhotoUrl: true }
        }
      }
    });

    // Update ticket status to 'In Progress' if it was 'Open' or update the timestamp
    await prisma.supportTicket.update({
      where: { id },
      data: { 
        updatedAt: new Date(),
        status: ticket.status === 'Open' ? 'In Progress' : ticket.status 
      }
    });

    // Note: We could add email notification to user here

    // Emit event to sockets (isAdminReply = true, receiverUserId = ticket.memberId)
    emitTicketReply(id, reply, ticket.memberId, true);
    
    return res.status(201).json({ message: 'Reply sent.', reply });
  } catch (error: any) {
    console.error('[Admin Reply Ticket Error]', error.message);
    return res.status(500).json({ error: 'Internal server error while replying to ticket.' });
  }
}

// Update ticket status or priority
export async function updateTicketStatus(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const { status, priority } = req.body;

  try {
    let updateData: any = { updatedAt: new Date() };
    if (status) updateData.status = status;
    if (priority) updateData.priority = priority;

    const ticket = await prisma.supportTicket.update({
      where: { id },
      data: updateData
    });

    return res.status(200).json({ message: 'Ticket updated successfully.', ticket });
  } catch (error: any) {
    console.error('[Update Ticket Status Error]', error.message);
    if (error.code === 'P2025') return res.status(404).json({ error: 'Ticket not found.' });
    return res.status(500).json({ error: 'Internal server error while updating ticket.' });
  }
}
