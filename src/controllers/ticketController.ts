import { Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth';
import { prisma } from '../config/db';
import { emitTicketReply } from '../config/socket';

// Create a new support ticket
export async function createTicket(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { subject, category, message, priority = 'Medium' } = req.body;

  if (!subject || !category || !message) {
    return res.status(400).json({ error: 'Subject, category, and message are required.' });
  }

  try {
    const newTicket = await prisma.supportTicket.create({
      data: {
        memberId: req.user.id,
        subject,
        category,
        priority,
        status: 'Open',
        replies: {
          create: {
            senderId: req.user.id,
            message
          }
        }
      },
      include: {
        replies: true
      }
    });

    return res.status(201).json({ message: 'Support ticket created successfully.', ticket: newTicket });
  } catch (error: any) {
    console.error('[Create Ticket Error]', error.message);
    return res.status(500).json({ error: 'Internal server error while creating ticket.' });
  }
}

// Get all tickets for the logged-in member
export async function getMyTickets(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const tickets = await prisma.supportTicket.findMany({
      where: { memberId: req.user.id },
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: {
          select: { replies: true }
        }
      }
    });
    return res.status(200).json({ tickets });
  } catch (error: any) {
    console.error('[Get My Tickets Error]', error.message);
    return res.status(500).json({ error: 'Internal server error while fetching tickets.' });
  }
}

// Get details of a specific ticket (with replies)
export async function getTicketDetails(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;

  try {
    const ticket = await prisma.supportTicket.findFirst({
      where: { id, memberId: req.user.id },
      include: {
        replies: {
          orderBy: { createdAt: 'asc' },
          include: {
            sender: {
              select: {
                id: true,
                fullName: true,
                systemRole: true,
                profilePhotoUrl: true
              }
            }
          }
        }
      }
    });

    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

    return res.status(200).json({ ticket });
  } catch (error: any) {
    console.error('[Get Ticket Details Error]', error.message);
    return res.status(500).json({ error: 'Internal server error while fetching ticket details.' });
  }
}

// Add a reply to a ticket
export async function replyToTicket(req: AuthenticatedRequest, res: Response) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { id } = req.params;
  const { message } = req.body;

  if (!message) return res.status(400).json({ error: 'Reply message cannot be empty.' });

  try {
    const ticket = await prisma.supportTicket.findFirst({
      where: { id, memberId: req.user.id }
    });

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

    // Automatically update the updatedAt timestamp of the ticket
    await prisma.supportTicket.update({
      where: { id },
      data: { updatedAt: new Date() }
    });

    // Emit event to sockets (isAdminReply = false)
    // Send to the ticket thread, but notify admins
    emitTicketReply(id, reply, '', false);

    return res.status(201).json({ message: 'Reply added.', reply });
  } catch (error: any) {
    console.error('[Reply Ticket Error]', error.message);
    return res.status(500).json({ error: 'Internal server error while replying to ticket.' });
  }
}
