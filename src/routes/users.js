const express = require('express');
const { countRows, deleteRow, fetchById, fetchMany, hasColumn, insertRow, updateRow } = require('../lib/db');
const { deleteSupabaseUser, registerUser, updateSupabaseUser } = require('../lib/auth');
const { buildFullName, filterUserRow, sanitizeUser } = require('../lib/users');
const checkPermission = require('../middlewares/checkPermission');
const { logAudit } = require('../lib/auditLogger');

const router = express.Router();

async function getUserDeleteDependencies(userId) {
  const [transactionCount, engineerSiteCount] = await Promise.all([
    countRows('transactions', [{ column: 'employeeId', operator: 'eq', value: userId }]),
    countRows('sites', [{ column: 'engineerId', operator: 'eq', value: userId }]),
  ]);

  return {
    transactionCount,
    engineerSiteCount,
    siteManagerCount: 0,
    totalSiteCount: engineerSiteCount,
  };
}

router.get('/', checkPermission('viewEmployees'), async (req, res) => {
  try {
    const users = await fetchMany('users', { orderBy: 'createdAt', ascending: false });
    res.json(users.map((user) => sanitizeUser(user)));
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.get('/:id', checkPermission('viewEmployees'), async (req, res) => {
  try {
    const user = sanitizeUser(await fetchById('users', req.params.id));
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.post('/', checkPermission('addEmployees'), async (req, res) => {
  try {
    const userData = { ...req.body };
    if (!userData.username || !userData.email || !userData.password) {
      return res.status(400).json({ message: 'Username, email, and password are required' });
    }
    if (userData.password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }
    const result = await registerUser(userData);
    const createdUser = sanitizeUser(result.user);

    logAudit({
      action: 'ADD_USER',
      entityType: 'user',
      entityId: createdUser.id || createdUser._id,
      user: req.user,
      req,
      previousValue: null,
      newValue: createdUser,
      details: `Created employee user: ${createdUser.username} (${createdUser.fullName || ''})`,
    }).catch((err) => console.error('[AuditLog] Add employee log error:', err));

    res.status(201).json(createdUser);
  } catch (err) {
    console.error('Create user error:', err);
    const message = err.message || 'Internal server error';
    const status = /already exists|required/i.test(message) ? 400 : 500;
    res.status(status).json({ message });
  }
});

router.put('/:id', checkPermission('editEmployees'), async (req, res) => {
  try {
    const updates = { ...req.body };

    if (updates.username && updates.username.length < 3) {
      return res.status(400).json({ message: 'Username must be at least 3 characters' });
    }

    const currentUser = await fetchById('users', req.params.id);
    if (!currentUser) return res.status(404).json({ message: 'User not found' });

    const nextFullName = updates.fullName || buildFullName({
      ...currentUser,
      ...updates,
    });
    if (nextFullName) {
      updates.fullName = nextFullName;
    }
    if (updates.password) {
      await updateSupabaseUser(currentUser, {
        password: updates.password,
        email: updates.email,
        username: updates.username,
        fullName: updates.fullName,
        role: updates.role,
        permission: updates.permission,
      });
      delete updates.password;
    } else {
      await updateSupabaseUser(currentUser, {
        email: updates.email,
        username: updates.username,
        fullName: updates.fullName,
        role: updates.role,
        permission: updates.permission,
      });
    }

    const filteredUpdates = filterUserRow(updates);
    delete filteredUpdates.id;
    delete filteredUpdates._id;
    delete filteredUpdates.created_at;

    const updatedUser = sanitizeUser(await updateRow('users', req.params.id, filteredUpdates));

    logAudit({
      action: 'EDIT_USER',
      entityType: 'user',
      entityId: req.params.id,
      user: req.user,
      req,
      previousValue: sanitizeUser(currentUser),
      newValue: updatedUser,
      details: `Edited user account: ${updatedUser.username || currentUser.username} (${updatedUser.fullName || currentUser.fullName})`,
    }).catch((err) => console.error('[AuditLog] Edit user log error:', err));

    res.json(updatedUser);
  } catch (err) {
    console.error('Update user error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

router.delete('/:id', checkPermission('deleteEmployees'), async (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ message: 'Cannot delete your own account' });
    }

    const existingUser = await fetchById('users', req.params.id);
    if (!existingUser) return res.status(404).json({ message: 'User not found' });

    const dependencies = await getUserDeleteDependencies(req.params.id);
    if (dependencies.transactionCount || dependencies.totalSiteCount) {
      const parts = [];
      if (dependencies.transactionCount) {
        parts.push(`${dependencies.transactionCount} transaction(s)`);
      }
      if (dependencies.engineerSiteCount) {
        parts.push(`${dependencies.engineerSiteCount} site(s) as engineer`);
      }
      if (dependencies.siteManagerCount) {
        parts.push(`${dependencies.siteManagerCount} site(s) as site manager`);
      }

      return res.status(409).json({
        message: `Cannot delete this user because they are still linked to ${parts.join(', ')}. Reassign or remove those records first.`,
        dependencies,
      });
    }

    const deletedUser = await deleteRow('users', req.params.id);
    if (!deletedUser) return res.status(404).json({ message: 'User not found' });

    try {
      await deleteSupabaseUser(existingUser);
    } catch (authDeleteError) {
      try {
        await insertRow('users', existingUser, { timestamps: false });
      } catch (restoreError) {
        console.error('Restore user after auth delete failure error:', restoreError);
      }
      throw authDeleteError;
    }

    logAudit({
      action: 'DELETE_USER',
      entityType: 'user',
      entityId: req.params.id,
      user: req.user,
      req,
      previousValue: sanitizeUser(existingUser),
      newValue: null,
      details: `Deleted user account: ${existingUser.username} (${existingUser.fullName})`,
    }).catch((err) => console.error('[AuditLog] Delete user log error:', err));

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ message: 'Failed to delete user' });
  }
});

module.exports = router;
