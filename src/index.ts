import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import * as path from 'path';
import swaggerUi from 'swagger-ui-express';

// Import configurations
import { pool } from './config/db';
import { swaggerSpec } from './config/swagger';

// Import route systems
import authRoutes from './routes/authRoutes';
import applicantRoutes from './routes/applicantRoutes';
import adminRoutes from './routes/adminRoutes';
import fileRoutes from './routes/fileRoutes';
import progressionRoutes from './routes/progressionRoutes';
import categoryRoutes from './routes/categoryRoutes';
import educationRoutes from './routes/educationRoutes';
import paymentRoutes from './routes/paymentRoutes';

// Load secure environment variables from .env.local
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS for decoupled Next.js frontend connection
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Express Terminal Request Logger
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`[RIQS Request] ${req.method} ${req.originalUrl} - Received from ${req.ip}`);
  next();
});

// 1. Swagger Interactive API UI Documentation Portal
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// 2. Public Health Check & Dependency Ping Probe
app.get('/health', async (req: Request, res: Response) => {
  try {
    const dbPing = await pool.query('SELECT 1');
    return res.status(200).json({
      status: 'healthy',
      service: 'RIQS Standalone Node.js REST API',
      database: dbPing.rows.length > 0 ? 'online' : 'offline',
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    return res.status(503).json({
      status: 'unhealthy',
      database: 'offline',
      error: err.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 3. Bind Decoupled API Route Systems
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/applicants', applicantRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/files', fileRoutes);
app.use('/api/v1/progression', progressionRoutes);
app.use('/api/v1/categories', categoryRoutes);
app.use('/api/v1/education', educationRoutes);
app.use('/api/v1/payments', paymentRoutes);

// 4. Fallback Route Handler (404 Page Not Found)
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: `Cannot resolve ${req.method} ${req.originalUrl}. Resource not found.` });
});

// 5. Global Error Catch Middleware
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error('[Global Exception Catch]:', err.stack || err.message || err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal security gateway exception.'
  });
});

// 6. Bootstrap Server listener
app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`[RIQS REST API] Standalone Backend Active.`);
  console.log(`[RIQS REST API] Server Listening: http://localhost:${PORT}`);
  console.log(`[RIQS REST API] Environment Mode: Development`);
  console.log(`[RIQS REST API] Interactive Docs: http://localhost:${PORT}/api-docs`);
  console.log(`=================================================`);
});
