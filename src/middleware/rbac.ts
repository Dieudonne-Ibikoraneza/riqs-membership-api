import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './auth';

// Strict Role-Based Access Control (RBAC) authorization filter
export function requireRoles(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Access Denied. User session not authenticated.' });
    }

    const userRole = req.user.role.toLowerCase();
    const normalizedAllowed = allowedRoles.map(r => r.toLowerCase());

    // Validate role permissions
    if (!normalizedAllowed.includes(userRole)) {
      console.warn(`[RBAC Policy] Access denied to user ${req.user.email} (Role: ${req.user.role}) for resource requiring: [${allowedRoles.join(', ')}]`);
      return res.status(403).json({ error: 'Access Denied. You do not have the required administrative permissions.' });
    }

    next();
  };
}
