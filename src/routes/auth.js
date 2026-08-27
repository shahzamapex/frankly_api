
const express = require('express');
const router = express.Router();
const { fetchOne, updateRow } = require('../lib/db');
const {
  changePassword,
  formatSessionPayload,
  refreshAccessToken,
  registerUser,
  signInWithPassword,
  verifyAccessToken,
} = require('../lib/auth');
const {
  generateUsername,
} = require('../lib/users');
const { logAudit } = require('../lib/auditLogger');

function isExpiredTokenError(err) {
  const message = err?.message?.toLowerCase?.() || '';
  return err?.code === 'bad_jwt' || message.includes('expired');
}

/**
 * @swagger
 * tags:
 *   name: Authentication
 *   description: User authentication endpoints
 */

/**
 * @swagger
 * /auth/login:
 *   post:
 *     summary: User login
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *       401:
 *         description: Invalid credentials
 */

/**
 * @swagger
 * /auth/signup:
 *   post:
 *     summary: Register new user
 *     tags: [Authentication]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *               - password
 *             properties:
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *               firstName:
 *                 type: string
 *               lastName:
 *                 type: string
 *     responses:
 *       201:
 *         description: User created
 *       400:
 *         description: Invalid input
 */

router.post('/generate-username', async (req, res) => {
  try {
    const { firstName, lastName } = req.body;
    const username = generateUsername(firstName, lastName);
    const exists = !!(await fetchOne('users', {
      filters: [{ column: 'username', operator: 'eq', value: username }],
    }));
    res.json({ username, exists });
  } catch (err) {
    console.error('Generate username error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/signup', async (req, res) => {
  try {
    const userData = { ...req.body };
    if (!userData.username || !userData.email || !userData.password) {
      return res.status(400).json({ message: 'Username, email, and password are required' });
    }
    if (userData.password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }
    const result = await registerUser(userData);

    logAudit({
      action: 'AUTH_SIGNUP',
      entityType: 'user',
      entityId: result.user.id || result.user._id,
      user: result.user,
      req,
      previousValue: null,
      newValue: {
        id: result.user.id || result.user._id,
        username: result.user.username,
        email: result.user.email,
        fullName: result.user.fullName,
        role: result.user.role,
      },
      details: `New user signup: ${result.user.username} (${result.user.fullName || ''})`,
    }).catch((err) => console.error('[AuditLog] Signup log error:', err));

    res.status(201).json({
      message: 'User created',
      ...formatSessionPayload(result.session, result.user),
    });
  } catch (err) {
    console.error('Signup error:', err);
    const message = err.message || 'Internal server error';
    const status = /already exists|required/i.test(message) ? 400 : 500;
    res.status(status).json({ message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    const result = await signInWithPassword(email, password);
    if (result.error) {
      const message = result.error.message || 'Invalid credentials';
      const status = /deactivated/i.test(message) ? 403 : 401;
      return res.status(status).json({ message });
    }
    if (!result.user?.isActive) return res.status(403).json({ message: 'Account is deactivated' });

    const updatedUser = await updateRow('users', result.user._id || result.user.id, {
      lastLoginAt: new Date().toISOString(),
    });

    logAudit({
      action: 'AUTH_LOGIN',
      entityType: 'user',
      entityId: updatedUser.id || updatedUser._id,
      user: updatedUser,
      req,
      previousValue: null,
      newValue: {
        id: updatedUser.id || updatedUser._id,
        username: updatedUser.username,
        role: updatedUser.role,
        lastLoginAt: updatedUser.lastLoginAt,
      },
      details: `User login: ${updatedUser.username}`,
    }).catch((err) => console.error('[AuditLog] Login log error:', err));

    res.json(formatSessionPayload(result.session, updatedUser));
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.get('/profile', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token provided' });

    const { user } = await verifyAccessToken(token);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.isActive == false) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    res.json(user);
  } catch (err) {
    if (isExpiredTokenError(err)) {
      console.warn('Profile request: expired access token');
      return res.status(401).json({
        message: 'Session expired. Please login again',
        code: 'session_expired',
      });
    }

    console.error('Profile error:', err);
    res.status(401).json({ message: 'Unauthorized' });
  }
});

router.post('/refresh-token', async (req, res) => {
  try {
    const refreshToken = req.body?.refreshToken;
    if (!refreshToken) return res.status(401).json({ message: 'No refresh token provided' });

    const result = await refreshAccessToken(refreshToken);
    if (!result.user?.isActive) return res.status(403).json({ message: 'Account is deactivated' });

    res.json(formatSessionPayload(result.session, result.user));
  } catch (err) {
    console.error('Refresh token error:', err);
    res.status(401).json({ message: 'Unauthorized' });
  }
});

router.put('/change-password', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token provided' });

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters' });
    }

    const { user } = await verifyAccessToken(token);
    if (!user) return res.status(404).json({ message: 'User not found' });

    await changePassword(token, currentPassword, newPassword);

    logAudit({
      action: 'AUTH_CHANGE_PASSWORD',
      entityType: 'user',
      entityId: user.id || user._id,
      user,
      req,
      previousValue: null,
      newValue: { passwordChanged: true },
      details: `Password changed for user: ${user.username}`,
    }).catch((err) => console.error('[AuditLog] Change password log error:', err));

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err);
    const message = err.message || 'Internal server error';
    const status = /incorrect/i.test(message) ? 401 : 500;
    res.status(status).json({ message });
  }
});

module.exports = router;
