import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key';

// Custom Type Definition to attach authenticated user session to Express Requests
export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    /** SystemRole — controls what actions this user can perform in the system.
     *  Values: Admin | Admin_Assistant | Reviewer | Head_Reviewer | Approver | Teacher | Mentor | Standard | Student
     */
    role: string;
    /** MemberClass — professional tier based on years of experience.
     *  Values: Student | Graduate | Technologist | Associate | Visiting | Corporate | Fellow | Life | Honorary
     */
    membershipClass: string;
  };
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  let token = '';
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query.token) {
    token = req.query.token as string;
  }

  if (!token) {
    return res.status(401).json({ error: 'Access Denied. Authorization token missing or malformed.' });
  }

  try {
    // Verify token validity directly against our local JWT secret
    const decoded = jwt.verify(token, JWT_SECRET) as any;

    // Attach normalized session parameters to request
    req.user = {
      id: decoded.id,
      email: decoded.email || '',
      role: decoded.role || 'Standard',             // systemRole
      membershipClass: decoded.membershipClass || 'Student', // professional tier
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

/** Guard: allow only specific system roles */
export function requireRole(...roles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Access Denied.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Access Denied. Required role: ${roles.join(' or ')}.` });
    }
    next();
  };
}
