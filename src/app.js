require('dotenv').config();

process.env.TZ = 'Asia/Dubai';

const express = require('express');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./swagger');
const authRoutes = require('./routes/auth');
const inventoryRoutes = require('./routes/inventory');
const siteRoutes = require('./routes/site');
const deliveryRoutes = require('./routes/delivery');
const uploadsRoutes = require('./routes/uploads');
const usersRoutes = require('./routes/users');
const transactionRoutes = require('./routes/transaction');
const appConfigRoutes = require('./routes/appConfig');
const vendorRoutes = require('./routes/vendor');
const { authMiddleware } = require('./middlewares/auth');

const app = express();

app.set('trust proxy', 1);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ?.split(',')
  .map(o => o.trim())
  .filter(Boolean) || [];

const corsOrigin = (origin, callback) => {
  if (!origin) {
    callback(null, true);
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

app.get('/', (req, res) => res.json({ status: 'ok' }));

app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.use('/api/auth', authRoutes);

app.use('/api/inventory', authMiddleware, inventoryRoutes);
app.use('/api/sites', authMiddleware, siteRoutes);
app.use('/api/deliveries', authMiddleware, deliveryRoutes);
app.use('/api/uploads', authMiddleware, uploadsRoutes);
app.use('/api/users', authMiddleware, usersRoutes);
app.use('/api/transactions', authMiddleware, transactionRoutes);
app.use('/api/vendors', authMiddleware, vendorRoutes);
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
