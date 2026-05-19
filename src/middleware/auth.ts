import { Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../config/db';

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
    // Verify token validity directly against Supabase Auth engine
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
    
    if (error || !user) {
      return res.status(401).json({ error: 'Access Denied. Session is invalid or expired.' });
    }

    // Attach normalized session parameters to request. Defaults to 'member' role unless set in metadata
    req.user = {
      id: user.id,
      email: user.email || '',
      role: user.user_metadata?.role || 'member'
    };

    next();
  } catch (err: any) {
    console.error('[Auth Middleware] Verification error:', err.message);
    return res.status(500).json({ error: 'Internal security validation gateway error.' });
  }
}
