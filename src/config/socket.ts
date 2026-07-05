import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

let io: Server;

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_development';

export function initializeSocket(server: HttpServer) {
  io = new Server(server, {
    cors: {
      origin: '*', // Same as Express config
      methods: ['GET', 'POST']
    }
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      const decoded = jwt.verify(token, JWT_SECRET) as { id: string; role?: string };
      (socket as any).user = decoded;
      next();
    } catch (error) {
      next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket as any).user;
    console.log(`[Socket] User connected: ${user.id} (${user.role || 'Member'})`);

    // Users join a room with their own ID to receive targeted alerts
    socket.join(user.id);
    
    // If Admin/Reviewer/Approver, they can also join an 'admins' room for global ticket updates
    if (user.role && ['Admin', 'Reviewer', 'Approver'].includes(user.role)) {
      socket.join('admins');
    }

    // Client can explicitly join a ticket room when viewing it
    socket.on('join_ticket', (ticketId: string) => {
      socket.join(`ticket_${ticketId}`);
      console.log(`[Socket] User ${user.id} joined ticket room: ticket_${ticketId}`);
    });

    socket.on('leave_ticket', (ticketId: string) => {
      socket.leave(`ticket_${ticketId}`);
      console.log(`[Socket] User ${user.id} left ticket room: ticket_${ticketId}`);
    });

    socket.on('disconnect', () => {
      console.log(`[Socket] User disconnected: ${user.id}`);
    });
  });

  return io;
}

export function getIO(): Server {
  if (!io) {
    throw new Error('Socket.io has not been initialized');
  }
  return io;
}

// Helper to emit new replies to the specific ticket room and the other party
export function emitTicketReply(ticketId: string, reply: any, receiverUserId: string, isAdminReply: boolean) {
  if (!io) return;
  
  // Emit to anyone actively viewing the ticket thread
  io.to(`ticket_${ticketId}`).emit('new_ticket_reply', { ticketId, reply });

  // If it's an admin replying, also notify the member globally (e.g. for notifications)
  if (isAdminReply) {
    io.to(receiverUserId).emit('ticket_notification', { ticketId, type: 'reply', reply });
  } else {
    // If it's a member replying, notify the admins globally
    io.to('admins').emit('ticket_notification', { ticketId, type: 'reply', reply });
  }
}
