import swaggerJSDoc from 'swagger-jsdoc';

const options: swaggerJSDoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'RIQS Membership Registry & Progression REST API',
      version: '1.0.0',
      description: `
## RIQS (Rwanda Institute of Quantity Surveyors) Enterprise REST API

This API handles the full workflow of member registration, 7-step wizard applications, private PDF/image blob storage streaming, double-entry financial ledger clearance, and structured mentorship tracking.

### Security Gateway
* **Bearer Authorization**: Most endpoints are private. Provide the JWT token received from \`/api/v1/auth/login\` in the Authorization header: \`Authorization: Bearer [JWT]\`.
* **Public Endpoints**: Endpoints that do not require authentication (e.g., login, register, public members directory) will not have the lock icon. They are accessible to anyone.
* **Role-Based Access Control (RBAC)**: Certain endpoints require \`admin\`, \`reviewer\`, or \`finance\` roles attached to your token payload.
`,
    },
    servers: [
      {
        url: 'http://localhost:5000',
        description: 'Local Development Server',
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Provide bearer token prefix: `Bearer [token]`'
        },
      },
    },
    security: [
      {
        BearerAuth: [],
      },
    ],
  },
  apis: ['./src/routes/*.ts', './src/routes/*.js', './dist/routes/*.js'],
};

export const swaggerSpec = swaggerJSDoc(options);
