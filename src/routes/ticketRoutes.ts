import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { createTicket, getMyTickets, getTicketDetails, replyToTicket } from '../controllers/ticketController';

const router = Router();

router.post('/', requireAuth, createTicket);
router.get('/', requireAuth, getMyTickets);
router.get('/:id', requireAuth, getTicketDetails);
router.post('/:id/replies', requireAuth, replyToTicket);

export default router;
