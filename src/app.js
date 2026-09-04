require('dotenv').config();

process.env.TZ = 'Asia/Dubai';

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');
const authRoutes = require('./routes/auth');
const inventoryRoutes = require('./routes/inventory');
const siteRoutes = require('./routes/site');
const uploadsRoutes = require('./routes/uploads');
const usersRoutes = require('./routes/users');
const transactionRoutes = require('./routes/transaction');
const appConfigRoutes = require('./routes/appConfig');
const auditLogRoutes = require('./routes/auditLogs');
const { authMiddleware } = require('./middlewares/auth');

const app = express();

app.set('trust proxy', 1);
app.use(compression());

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ?.split(',')
  .map(o => o.trim())
  .filter(Boolean) || [];

const corsOrigin = (origin, callback) => {
  if (!origin) {
    callback(null, true);
    return;
  }

  // Always allow localhost and 127.0.0.1 for local web development
  if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
    callback(null, origin);
    return;
  }

  if (allowedOrigins.length === 0) {
    callback(null, origin);
    return;
  }

  if (allowedOrigins.includes(origin)) {
    callback(null, origin);
    return;
  }

  callback(new Error(`CORS blocked for origin: ${origin}`));
};

app.use(cors({
  origin: corsOrigin,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  next();
});

const { getSupabaseAdmin } = require('./lib/supabase');
const { runCloudinaryOrphanCleanup } = require('../cleanup-cloudinary-orphans');

app.get('/', (req, res) => res.json({ status: 'ok', api: 'Frankly Warehouse API', docs: '/api/docs', health: '/health' }));

const healthCheckHandler = async (req, res) => {
  const startTime = Date.now();
  let dbStatus = 'connected';
  let dbLatencyMs = 0;

  try {
    const dbStart = Date.now();
    const { error } = await getSupabaseAdmin().from('users').select('id').limit(1);
    dbLatencyMs = Date.now() - dbStart;
    if (error) {
      dbStatus = 'degraded';
    }
  } catch (err) {
    dbStatus = 'unreachable';
  }

  // Run Cloudinary Orphan Cleanup with automatic permanent deletion
  let cloudinaryResult = null;
  try {
    cloudinaryResult = await runCloudinaryOrphanCleanup({ isDeleteMode: true, silent: true });
  } catch (cErr) {
    cloudinaryResult = {
      status: 'error',
      error: cErr.message,
    };
  }

  const isHealthy = dbStatus === 'connected' || dbStatus === 'degraded';
  res.status(isHealthy ? 200 : 503).json({
    status: dbStatus === 'connected' ? 'healthy' : (dbStatus === 'degraded' ? 'degraded' : 'unhealthy'),
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    database: {
      status: dbStatus,
      latencyMs: dbLatencyMs,
    },
    memory: {
      rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`,
      heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
    },
    cloudinaryCleanup: cloudinaryResult,
    responseTimeMs: Date.now() - startTime,
  });
};

app.get('/health', healthCheckHandler);
app.get('/api/health', healthCheckHandler);

app.get('/api/docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json(swaggerSpec);
});

const renderSwaggerHtml = () => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Frankly Warehouse Management API Docs</title>
  <link rel="stylesheet" type="text/css" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui.min.css" />
  <link rel="icon" type="image/png" href="https://res.cloudinary.com/daoummcel/image/upload/v1774943434/logo_oqzyhe.png" />
  <style>
    html { box-sizing: border-box; overflow-y: scroll; }
    *, *:before, *:after { box-sizing: inherit; }
    body { margin: 0; background: #fafafa; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .swagger-ui .topbar { display: none !important; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-bundle.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.11.0/swagger-ui-standalone-preset.js"></script>
  <script>
    window.onload = function() {
      window.ui = SwaggerUIBundle({
        spec: ${JSON.stringify(swaggerSpec)},
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout",
        persistAuthorization: true,
        displayRequestDuration: true,
        docExpansion: "list",
        filter: true
      });
    };
  </script>
</body>
</html>`;

app.get('/api/docs', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderSwaggerHtml());
});

app.get('/docs', (req, res) => {
  res.redirect('/api/docs');
});

app.use('/api/auth', authRoutes);

app.use('/api/inventory', authMiddleware, inventoryRoutes);
app.use('/api/sites', authMiddleware, siteRoutes);
app.use('/api/uploads', authMiddleware, uploadsRoutes);
app.use('/api/users', authMiddleware, usersRoutes);
app.use('/api/transactions', authMiddleware, transactionRoutes);
app.use('/api/transaction', authMiddleware, transactionRoutes);
app.use('/api/audit-logs', authMiddleware, auditLogRoutes);
app.use('/api/app-config', appConfigRoutes);

app.use((err, req, res, _next) => {
  console.error('Error:', err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

module.exports = app;
