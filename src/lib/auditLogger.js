const { insertRow } = require('./db');

/**
 * Creates an audit log entry in the database.
 * Logs previous value and new value for database tracking without affecting the app.
 *
 * @param {Object} params
 * @param {'ADD_TRANSACTION'|'ADD_INVENTORY'|'EDIT_INVENTORY'|string} params.action - Action performed
 * @param {'transaction'|'inventory'|string} params.entityType - Target entity type
 * @param {string|number} params.entityId - ID of target entity
 * @param {Object} [params.user] - req.user object (from auth middleware)
 * @param {Object} [params.req] - Express request object (to extract IP & user if not provided)
 * @param {Object|null} [params.previousValue] - Snapshot before change (null for creation)
 * @param {Object|null} [params.newValue] - Snapshot after change
 * @param {string} [params.details] - Human-readable summary
 */
async function logAudit({
  action,
  entityType,
  entityId,
  user = null,
  req = null,
  previousValue = null,
  newValue = null,
  details = null,
}) {
  try {
    const currentUser = user || req?.user || null;
    const ipAddress =
      req?.headers?.['x-forwarded-for']?.split(',')?.[0]?.trim() ||
      req?.ip ||
      req?.socket?.remoteAddress ||
      null;

    // For edits (both snapshots present) store only the changed fields, so
    // audit rows stay small and the Diff view shows just the change.
    let loggedPrevious = previousValue;
    let loggedNew = newValue;
    if (previousValue && newValue && typeof previousValue === 'object' && typeof newValue === 'object') {
      const delta = diffForLog(previousValue, newValue);
      loggedPrevious = delta ? Object.fromEntries(
        Object.entries(delta).map(([key, change]) => [key, change.from])
      ) : {};
      loggedNew = delta ? Object.fromEntries(
        Object.entries(delta).map(([key, change]) => [key, change.to])
      ) : {};
    }

    const logEntry = {
      action: String(action),
      entityType: String(entityType),
      entityId: entityId !== undefined && entityId !== null ? String(entityId) : null,
      userId: currentUser?.id || currentUser?._id || currentUser?.userId || null,
      username: currentUser?.username || null,
      userFullName: currentUser?.fullName || currentUser?.name || null,
      previousValue: loggedPrevious ? sanitizeForLog(loggedPrevious) : null,
      newValue: loggedNew ? sanitizeForLog(loggedNew) : null,
      details: details || `${action} on ${entityType} ${entityId || ''}`.trim(),
      ipAddress,
      createdAt: new Date().toISOString(),
    };

    // Attempt to persist to audit_logs table, with fallback to logs table if audit_logs does not exist
    try {
      await insertRow('audit_logs', logEntry);
    } catch (err) {
      if (
        err?.code === 'PGRST204' ||
        err?.code === '42P01' ||
        err?.message?.includes('not found') ||
        err?.message?.includes('does not exist')
      ) {
        try {
          await insertRow('logs', logEntry);
        } catch (innerErr) {
          console.warn('[AuditLogger] DB log skipped (table not found in schema):', innerErr.message);
        }
      } else {
        console.warn('[AuditLogger] DB log error:', err.message);
      }
    }
  } catch (error) {
    console.error('[AuditLogger] Unexpected error in logAudit:', error);
  }
}

/**
 * Helper to log a list of audit events in parallel.
 */
async function logAuditBatch(entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  await Promise.allSettled(entries.map((entry) => logAudit(entry)));
}

/**
 * Extracts only the fields that differ between the previous and next
 * snapshots: { field: { from, to } }. Returns null when nothing changed.
 */
function diffForLog(previousValue, newValue) {
  const prev = sanitizeForLog(previousValue);
  const next = sanitizeForLog(newValue);
  if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') {
    return null;
  }

  const result = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    const before = JSON.stringify(prev[key] ?? null);
    const after = JSON.stringify(next[key] ?? null);
    if (before !== after) {
      result[key] = { from: prev[key] ?? null, to: next[key] ?? null };
    }
  }
  return Object.keys(result).length ? result : null;
}

/**
 * Sanitizes object by removing sensitive fields (passwords, tokens).
 */
function sanitizeForLog(data) {
  if (!data || typeof data !== 'object') return data;
  try {
    const clone = JSON.parse(JSON.stringify(data));
    delete clone.password;
    delete clone.token;
    delete clone.accessToken;
    delete clone.refreshToken;
    return clone;
  } catch (_) {
    return data;
  }
}

module.exports = {
  logAudit,
  logAuditBatch,
};
