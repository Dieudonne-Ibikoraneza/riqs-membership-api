import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth';

// Strict Role-Based Access Control (RBAC) authorization filter
export function requireRoles(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Access Denied. User session not authenticated.' });
    }

    const { role } = req.user;

    // Validate role permissions
    if (!allowedRoles.includes(role)) {
      console.warn(`[RBAC Policy] Access denied to user ${req.user.email} (Role: ${role}) for resource requiring: [${allowedRoles.join(', ')}]`);
      return res.status(403).json({ error: 'Access Denied. You do not have the required administrative permissions.' });
    }

    next();
  };
}
