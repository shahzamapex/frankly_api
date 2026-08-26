const checkPermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized', requiresPermission: true });
    }

    const isAdmin = String(req.user.role || '').toLowerCase() === 'admin';
    const hasAdminPermission = req.user.permission === true || req.user.permission === 'true' || req.user.permission === 1;

    // If user is admin OR user has permission=true, grant full access
    if (isAdmin || hasAdminPermission) {
      return next();
    }

    const normalized = String(permission || '').toLowerCase();

    // View operations are allowed for all users
    if (normalized.startsWith('view')) {
      return next();
    }

    // Write, update, delete, approve operations blocked if neither admin nor permission=true
    if (
      normalized.startsWith('add') ||
      normalized.startsWith('edit') ||
      normalized.startsWith('update') ||
      normalized.startsWith('delete') ||
      normalized.startsWith('approve') ||
      normalized.startsWith('refresh')
    ) {
      return res.status(403).json({ 
        message: 'You do not have permission to access this feature. Please contact your administrator.', 
        requiresPermission: true,
        permission: permission 
      });
    }

    next();
  };
};

module.exports = checkPermission;
