// api/src/routes/summary.js
// Server-side aggregation endpoints so the mobile client stops
// downloading entire collections to compute dashboard / employee stats.
// Strategy: try the Postgres RPC created by
// api/migrations/001_stockgrid_improvements.sql first (fast, single round
// trip); if the function is not deployed yet, fall back to JS aggregation
// with lean selects so the endpoint still works pre-migration.
const express = require('express');
const { fetchMany, hasColumn } = require('../lib/db');
const { getSupabaseAdmin } = require('../lib/supabase');
const checkPermission = require('../middlewares/checkPermission');

const router = express.Router();

// Dubai local day start (UTC+4), matching the API's getDubaiTime().
function dubaiDayStart() {
  const now = new Date();
  const dubai = new Date(now.getTime() + 4 * 60 * 60 * 1000);
  dubai.setHours(0, 0, 0, 0);
  return new Date(dubai.getTime() - 4 * 60 * 60 * 1000); // back to UTC
}

const STOCK_IN_TYPES = [
  'RETURN_SITE', 'RETURN_EMPLOYEE', 'RETURN_REPAIR', 'RETURN_NEW', 'DELIVERY',
];
const STOCK_OUT_TYPES = [
  'ISSUE_SITE', 'ISSUE_EMPLOYEE', 'ISSUE_REPAIR', 'ISSUE_SCRAP',
];
const TRANSFER_TYPES = ['SITE_TRANSFER', 'SITE TRANSFER'];

function normalizeType(type) {
  return String(type || '').trim().toUpperCase().replace(/\s+/g, '_');
}

async function summaryViaRpc() {
  const { data, error } = await getSupabaseAdmin().rpc('dashboard_summary');
  if (error) throw error;
  return data;
}

async function summaryViaJs() {
  const since = dubaiDayStart().toISOString();

  const [todayTxns, inventories, sites] = await Promise.all([
    fetchMany('transactions', {
      select: 'id,transaction_id,type,quantity,created_at',
      filters: [{ column: 'createdAt', operator: 'gte', value: since }],
    }),
    fetchMany('inventories', {
      select: 'id,current_stock,status,reorder_level',
    }),
    fetchMany('sites', { select: 'id,type,status' }),
  ]);

  let todayInwardQty = 0;
  let todayOutwardQty = 0;
  let todayTransferQty = 0;
  const operationKeys = new Set();
  for (const txn of todayTxns) {
    const type = normalizeType(txn.type);
    const qty = Number(txn.quantity || 0);
    if (STOCK_IN_TYPES.includes(type)) todayInwardQty += qty;
    else if (STOCK_OUT_TYPES.includes(type)) todayOutwardQty += qty;
    else if (TRANSFER_TYPES.includes(type)) todayTransferQty += qty;
    const key = String(txn.transactionId || txn.id || '');
    if (key) operationKeys.add(key);
  }

  let lowStockCount = 0;
  let outOfStockCount = 0;
  for (const item of inventories) {
    const stock = Number(item.currentStock ?? 0);
    const reorder = Number(item.reorderLevel ?? item.reorder_level ?? 0);
    if (stock <= 0) outOfStockCount += 1;
    else if (reorder > 0 && stock <= reorder) lowStockCount += 1;
  }

  const activeProjectSites = sites.filter((site) => {
    const status = String(site.status || '').trim().toLowerCase();
    const type = String(site.type || '').trim().toUpperCase();
    return (status === 'active' || status === 'ongoing' || status === '') && type === 'PROJECT';
  }).length;

  return {
    todayInwardQty,
    todayOutwardQty,
    todayTransferQty,
    todayOperationsCount: operationKeys.size,
    lowStockCount,
    outOfStockCount,
    itemCount: inventories.length,
    activeSiteCount: activeProjectSites,
  };
}

// GET /api/dashboard/summary
router.get('/dashboard', checkPermission('viewInventory'), async (req, res) => {
  try {
    let summary = null;
    try {
      summary = await summaryViaRpc();
      if (summary && typeof summary === 'object') {
        summary = { ...summary, source: 'rpc' };
      }
    } catch (_) {
      // RPC not deployed yet — fall through to JS aggregation.
    }
    if (!summary) {
      summary = { ...(await summaryViaJs()), source: 'js' };
    }
    res.json(summary);
  } catch (err) {
    console.error('Get dashboard summary error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dashboard/employee-items/:employeeId
// Per-employee item custody aggregation (mirrors the app's issue/return
// netting): ISSUE_EMPLOYEE adds, RETURN_EMPLOYEE subtracts.
// ---------------------------------------------------------------------------
router.get(
  '/dashboard/employee-items/:employeeId',
  checkPermission('viewInventory'),
  async (req, res) => {
    try {
      const employeeId = String(req.params.employeeId || '').trim();
      if (!employeeId) {
        return res.status(400).json({ error: 'Employee id is required' });
      }

      const [hasEmployeeIdCol, hasEmployeeCol] = await Promise.all([
        hasColumn('transactions', 'employeeId'),
        hasColumn('transactions', 'employee'),
      ]);
      if (!hasEmployeeIdCol && !hasEmployeeCol) {
        return res.status(501).json({
          error: 'Employee columns are unavailable on this deployment',
        });
      }

      const orClauses = [];
      if (hasEmployeeIdCol) orClauses.push(`employee_id.eq.${employeeId}`);
      if (hasEmployeeCol) orClauses.push(`employee.eq.${employeeId}`);

      const transactions = await fetchMany('transactions', {
        select: 'id,type,quantity,inventory_id,employee_id,transaction_id,created_at',
        filters: [
          { column: 'or', operator: 'or', value: orClauses.join(',') },
        ],
      });

      const quantities = new Map();
      let txnCount = 0;
      for (const txn of transactions) {
        const itemId = String(
          txn.inventoryId || txn.itemId || '',
        ).trim();
        if (!itemId) continue;

        const type = normalizeType(txn.type);
        const qty = Number(txn.quantity || 0);
        if (type === 'ISSUE_EMPLOYEE') {
          quantities.set(itemId, (quantities.get(itemId) || 0) + qty);
          txnCount += 1;
        } else if (
          type === 'RETURN_EMPLOYEE' ||
          type === 'RETURN'
        ) {
          quantities.set(itemId, (quantities.get(itemId) || 0) - qty);
          txnCount += 1;
        }
      }

      const itemIds = [...quantities.keys()].filter(
        (itemId) => (quantities.get(itemId) || 0) > 0,
      );

      const items = itemIds.length
        ? await fetchMany('inventories', {
            select: 'id,sku,name,category,unit_of_measure,status,image_url,current_stock',
            filters: [{ column: 'id', operator: 'in', value: itemIds }],
          })
        : [];

      const itemsWithQty = items
        .map((item) => ({
          ...item,
          quantity: quantities.get(String(item.id)) || 0,
        }))
        .sort((a, b) =>
          String(a.name || '').localeCompare(String(b.name || '')),
        );

      res.json({
        employeeId,
        totalItems: itemsWithQty.length,
        totalQuantity: itemsWithQty.reduce(
          (sum, item) => sum + (item.quantity || 0),
          0,
        ),
        transactionCount: txnCount,
        items: itemsWithQty,
      });
    } catch (err) {
      console.error('Get employee item summary error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

module.exports = router;
