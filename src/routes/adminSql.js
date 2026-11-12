const express = require('express');
const { getSupabaseAdmin } = require('../lib/supabase');
const { authMiddleware } = require('../middlewares/auth');

const router = express.Router();

function isUserAdmin(user) {
  if (!user) return false;
  const role = String(user.role || user.user_metadata?.role || '').toLowerCase().trim();
  const isAdmin =
    role === 'admin' ||
    role === 'superadmin' ||
    role === 'super_admin' ||
    role === 'administrator' ||
    role === 'storekeeper' ||
    role === 'manager';
  const userPerm = user.permission ?? user.user_metadata?.permission;
  const hasAdminPerm =
    userPerm === true ||
    userPerm === 'true' ||
    userPerm === 1 ||
    userPerm === '1';

  return isAdmin || hasAdminPerm;
}

const SETUP_SQL = `CREATE OR REPLACE FUNCTION public.exec_sql(query_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    cleaned_query text;
    result_data jsonb;
    affected_rows integer;
BEGIN
    cleaned_query := TRIM(query_text);
    IF LOWER(cleaned_query) ~ '^(\\s*with\\s+.+\\s+select|\\s*select)\\s' THEN
        BEGIN
            EXECUTE 'SELECT jsonb_agg(row_to_json(t)) FROM (' || cleaned_query || ') t' INTO result_data;
            RETURN jsonb_build_object(
                'success', true,
                'type', 'SELECT',
                'rowCount', COALESCE(jsonb_array_length(result_data), 0),
                'data', COALESCE(result_data, '[]'::jsonb)
            );
        EXCEPTION WHEN OTHERS THEN
            RETURN jsonb_build_object('success', false, 'error', SQLERRM);
        END;
    ELSE
        BEGIN
            EXECUTE cleaned_query;
            GET DIAGNOSTICS affected_rows = ROW_COUNT;
            RETURN jsonb_build_object(
                'success', true,
                'type', 'COMMAND',
                'rowsAffected', affected_rows,
                'message', 'Executed successfully (' || affected_rows || ' row(s) affected)'
            );
        EXCEPTION WHEN OTHERS THEN
            RETURN jsonb_build_object('success', false, 'error', SQLERRM);
        END;
    END IF;
END;
$$;`;

/**
 * POST /api/admin/sql/execute
 * Body: { query: string }
 */
router.post('/execute', authMiddleware, async (req, res) => {
  try {
    if (!isUserAdmin(req.user)) {
      return res.status(403).json({
        success: false,
        error: 'Access denied: Terminal SQL Console requires Admin privileges.',
      });
    }

    const { query } = req.body;
    if (!query || typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Query string is required and cannot be empty.',
      });
    }

    const cleanedQuery = query.trim();

    // Call Supabase RPC exec_sql
    const { data, error } = await getSupabaseAdmin().rpc('exec_sql', {
      query_text: cleanedQuery,
    });

    if (error) {
      const errMsg = error.message || '';
      if (
        errMsg.includes('exec_sql') &&
        (errMsg.includes('does not exist') || errMsg.includes('not found'))
      ) {
        return res.status(400).json({
          success: false,
          requiresSetup: true,
          error:
            'The "exec_sql" function is not installed in Supabase yet. Please run the setup script in your Supabase SQL editor.',
          setupSql: SETUP_SQL,
        });
      }

      return res.status(400).json({
        success: false,
        error: errMsg,
      });
    }

    return res.json(data);
  } catch (err) {
    console.error('Terminal SQL Execute Error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error while executing query',
    });
  }
});

module.exports = router;

