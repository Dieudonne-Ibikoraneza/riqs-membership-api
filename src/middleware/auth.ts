import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';

// Custom Type Definition to attach authenticated user session to Express Requests
export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string; // 'admin' | 'reviewer' | 'finance' | 'member'
  };
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Access Denied. Authorization token missing or malformed.' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Verify token validity directly against our local JWT secret
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    
    // Attach normalized session parameters to request. Defaults to 'member' role unless set in metadata
    req.user = {
      id: decoded.id,
      email: decoded.email || '',
      role: decoded.role || 'member'
    };

    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Access Denied. Session has expired.' });
    }
    console.error('[Auth Middleware] Verification error:', err.message);
    return res.status(401).json({ error: 'Access Denied. Session is invalid.' });
  }
}
