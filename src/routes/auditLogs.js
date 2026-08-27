const express = require('express');
const { fetchMany, hasColumn } = require('../lib/db');
const { getSupabaseAdmin } = require('../lib/supabase');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const {
      userId,
      entityType,
      action,
      search,
      limit = 100,
      offset = 0,
    } = req.query;

    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const parsedOffset = Math.max(parseInt(offset, 10) || 0, 0);

    const supabase = getSupabaseAdmin();
    let query = supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .range(parsedOffset, parsedOffset + parsedLimit - 1);

    if (userId && String(userId).trim()) {
      query = query.eq('user_id', String(userId).trim());
    }

    if (entityType && String(entityType).trim() && String(entityType).toLowerCase() !== 'all') {
      const type = String(entityType).trim().toLowerCase();
      if (type === 'transaction' || type === 'transactions') {
        query = query.in('entity_type', ['transaction', 'delivery']);
      } else if (type === 'user' || type === 'users' || type === 'staff' || type === 'employee') {
        query = query.in('entity_type', ['user', 'employee', 'staff']);
      } else {
        query = query.eq('entity_type', type);
      }
    }

    if (action && String(action).trim()) {
      query = query.eq('action', String(action).trim());
    }

    if (search && String(search).trim()) {
      const term = `%${String(search).trim()}%`;
      query = query.or(`details.ilike.${term},username.ilike.${term},user_full_name.ilike.${term},action.ilike.${term},entity_id.ilike.${term}`);
    }

    const { data, error } = await query;

    if (error) {
      // Fallback: If audit_logs table does not exist or error occurs, try fallback query via db helper
      console.warn('[AuditLogs API] Query error on audit_logs:', error.message);
      try {
        const filters = [];
        if (userId) {
          filters.push({ column: 'userId', operator: 'eq', value: userId });
        }
        if (entityType && String(entityType).toLowerCase() !== 'all') {
          filters.push({ column: 'entityType', operator: 'eq', value: entityType });
        }
        if (action) {
          filters.push({ column: 'action', operator: 'eq', value: action });
        }

        const fallbackData = await fetchMany('audit_logs', {
          filters,
          limit: parsedLimit,
          offset: parsedOffset,
          orderBy: 'createdAt',
          ascending: false,
        });

        return res.json(fallbackData || []);
      } catch (fallbackErr) {
        console.warn('[AuditLogs API] Fallback error:', fallbackErr.message);
        return res.json([]);
      }
    }

    // Normalize keys to camelCase for Flutter API consistency
    const normalized = (data || []).map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entity_type || row.entityType,
      entityId: row.entity_id || row.entityId,
      userId: row.user_id || row.userId,
      username: row.username,
      userFullName: row.user_full_name || row.userFullName,
      previousValue: row.previous_value ?? row.previousValue ?? null,
      newValue: row.new_value ?? row.newValue ?? null,
      details: row.details,
      ipAddress: row.ip_address || row.ipAddress,
      createdAt: row.created_at || row.createdAt,
      updatedAt: row.updated_at || row.updatedAt,
    }));

    res.json(normalized);
  } catch (err) {
    console.error('Get audit logs error:', err);
    res.status(500).json({ error: 'Failed to retrieve audit logs' });
  }
});

module.exports = router;
