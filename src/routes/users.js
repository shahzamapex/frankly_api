const express = require('express');
const { countRows, deleteRow, fetchById, fetchMany, hasColumn, insertRow, updateRow } = require('../lib/db');
const { deleteSupabaseUser, updateSupabaseUser } = require('../lib/auth');
const { buildFullName, filterUserRow, sanitizeUser } = require('../lib/users');
const checkPermission = require('../middlewares/checkPermission');

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

    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error('Delete user error:', err);
    res.status(500).json({ message: 'Failed to delete user' });
  }
});

module.exports = router;
