const express = require('express');
const {
  fetchById,
  fetchMany,
  insertRow,
  insertRows,
  updateRow,
  deleteRow,
  uniqueIds,
  indexById,
} = require('../lib/db');
const checkPermission = require('../middlewares/checkPermission');
const { logAudit } = require('../lib/auditLogger');

const router = express.Router();

// In-memory fallback if the Supabase reservations table is not yet created
let _fallbackReservations = [];

function isTableMissingError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  const code = String(err.code || '').toLowerCase();
  return (
    code === '42p01' ||
    msg.includes('relation "reservations" does not exist') ||
    msg.includes('could not find the table') ||
    msg.includes('schema cache')
  );
}

function getDubaiTime() {
  return new Date(new Date().getTime() + 4 * 60 * 60 * 1000);
}

function formatTimestamp(d = getDubaiTime()) {
  const date = d instanceof Date ? d : new Date(d);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${dd}${mm}${yy}${hh}${min}${ss}`;
}

async function populateReservations(reservations) {
  if (!reservations || !reservations.length) {
    return [];
  }

  const itemIds = uniqueIds(
    reservations.map((r) => r.itemId || r.item_id).filter(Boolean),
  );
  const siteIds = uniqueIds(
    reservations.map((r) => r.siteId || r.site_id).filter(Boolean),
  );

  const [items, sites] = await Promise.all([
    itemIds.length
      ? fetchMany('inventories', {
          filters: [{ column: 'id', operator: 'in', value: itemIds }],
        }).catch(() => [])
      : [],
    siteIds.length
      ? fetchMany('sites', {
          filters: [{ column: 'id', operator: 'in', value: siteIds }],
        }).catch(() => [])
      : [],
  ]);

  const itemMap = indexById(
    items.map((it) => ({
      id: it.id || it._id,
      name: it.itemName || it.name,
      sku: it.sku,
      image: it.image || (Array.isArray(it.images) ? it.images[0] : null),
      unitOfMeasure: it.unitOfMeasure || it.unit_of_measure || it.uom || '',
    })),
  );

  const siteMap = indexById(
    sites.map((s) => ({
      id: s.id || s._id,
      siteName: s.siteName || s.name || 'WH',
      siteCode: s.siteCode || s.code || 'WH',
    })),
  );

  return reservations.map((res) => {
    const itId = String(res.itemId || res.item_id || '');
    const stId = String(res.siteId || res.site_id || '');
    const itInfo = itemMap.get(itId) || {};
    const stInfo = siteMap.get(stId) || {};

    return {
      id: res.id || res._id,
      reservationId: res.reservationId || res.reservation_id,
      itemId: itId,
      itemName: res.itemName || itInfo.name || 'Item',
      itemSku: res.itemSku || itInfo.sku || '',
      itemImage: itInfo.image || null,
      unitOfMeasure: itInfo.unitOfMeasure || '',
      siteId: stId,
      siteName: res.siteName || stInfo.siteName || 'Site',
      siteCode: stInfo.siteCode || '',
      quantity: Number(res.quantity || 1),
      reservedBy: res.reservedBy || res.reserved_by || 'Store Keeper',
      notes: res.notes || res.remark || '',
      status: String(res.status || 'ACTIVE').toUpperCase(),
      createdAt: res.createdAt || res.created_at || new Date().toISOString(),
      updatedAt: res.updatedAt || res.updated_at || new Date().toISOString(),
      fulfilledAt: res.fulfilledAt || res.fulfilled_at || null,
      fulfilledTxnId: res.fulfilledTxnId || res.fulfilled_txn_id || null,
      cancelReason: res.cancelReason || res.cancel_reason || null,
      cancelledAt: res.cancelledAt || res.cancelled_at || null,
    };
  });
}

// GET /api/reservations - list reservations
router.get('/', async (req, res) => {
  try {
    const siteId = req.query.siteId || req.query.site_id;
    const itemId = req.query.itemId || req.query.item_id;
    const status = req.query.status ? String(req.query.status).toUpperCase() : null;

    let rows = [];
    try {
      const filters = [];
      if (siteId) filters.push({ column: 'site_id', operator: 'eq', value: siteId });
      if (itemId) filters.push({ column: 'item_id', operator: 'eq', value: itemId });
      if (status && status !== 'ALL') {
        filters.push({ column: 'status', operator: 'eq', value: status });
      }

      rows = await fetchMany('reservations', {
        filters,
        order: [{ column: 'created_at', ascending: false }],
      });
    } catch (dbErr) {
      if (isTableMissingError(dbErr)) {
        rows = _fallbackReservations;
        if (siteId) rows = rows.filter((r) => r.siteId === siteId);
        if (itemId) rows = rows.filter((r) => r.itemId === itemId);
        if (status && status !== 'ALL') rows = rows.filter((r) => r.status === status);
      } else {
        throw dbErr;
      }
    }

    const populated = await populateReservations(rows);
    res.json(populated);
  } catch (err) {
    console.error('Fetch reservations error:', err);
    res.status(500).json({ error: 'Failed to fetch reservations' });
  }
});

// POST /api/reservations - create single or bulk reservations
router.post('/', async (req, res) => {
  try {
    const rawItems = Array.isArray(req.body?.items)
      ? req.body.items
      : (Array.isArray(req.body) ? req.body : [req.body]);

    if (!rawItems.length) {
      return res.status(400).json({ error: 'At least one reservation item is required' });
    }

    const now = getDubaiTime();
    const createdAt = now.toISOString();
    const baseStamp = formatTimestamp(now);

    const rowsToInsert = rawItems.map((item, idx) => {
      const itemId = item.itemId || item.item_id || item.item;
      const siteId = item.siteId || item.site_id || item.site;
      const quantity = Math.max(1, Number(item.quantity || 1));
      const resId = item.reservationId || `RES-${baseStamp}-${idx + 1}`;

      return {
        reservationId: resId,
        itemId,
        siteId,
        quantity,
        reservedBy: item.reservedBy || req.user?.fullName || req.user?.username || 'Store Keeper',
        notes: item.notes || item.remark || item.reason || '',
        status: 'ACTIVE',
        createdAt,
        updatedAt: createdAt,
      };
    });

    let inserted = [];
    try {
      inserted = await insertRows('reservations', rowsToInsert);
    } catch (dbErr) {
      if (isTableMissingError(dbErr)) {
        inserted = rowsToInsert.map((r, i) => ({
          id: `local_res_${Date.now()}_${i}`,
          ...r,
        }));
        _fallbackReservations.unshift(...inserted);
      } else {
        throw dbErr;
      }
    }

    const populated = await populateReservations(inserted);

    for (const resItem of populated) {
      logAudit({
        action: 'ADD_RESERVATION',
        entityType: 'reservation',
        entityId: resItem.id,
        user: req.user,
        req,
        previousValue: null,
        newValue: resItem,
        details: `Reserved ${resItem.quantity} of ${resItem.itemName} for ${resItem.siteName}`,
      }).catch((err) => console.error('[AuditLog] Add reservation error:', err));
    }

    res.status(201).json(populated.length === 1 && !Array.isArray(req.body?.items) ? populated[0] : populated);
  } catch (err) {
    console.error('Create reservations error:', err);
    res.status(400).json({ error: err.message || 'Failed to create reservation' });
  }
});

// PUT /api/reservations/:id/fulfill - mark fulfilled when issued
router.put('/:id/fulfill', async (req, res) => {
  try {
    const id = req.params.id;
    const txnId = req.body.txnId || req.body.transactionId || null;
    const now = getDubaiTime().toISOString();

    const updateData = {
      status: 'FULFILLED',
      fulfilledAt: now,
      fulfilledTxnId: txnId,
      updatedAt: now,
    };

    let updated = null;
    try {
      updated = await updateRow('reservations', id, updateData);
    } catch (dbErr) {
      if (isTableMissingError(dbErr)) {
        const idx = _fallbackReservations.findIndex((r) => r.id === id || r.reservationId === id);
        if (idx >= 0) {
          _fallbackReservations[idx] = { ..._fallbackReservations[idx], ...updateData };
          updated = _fallbackReservations[idx];
        }
      } else {
        throw dbErr;
      }
    }

    const populated = await populateReservations(updated ? [updated] : []);
    res.json(populated[0] || { success: true });
  } catch (err) {
    console.error('Fulfill reservation error:', err);
    res.status(400).json({ error: err.message || 'Failed to fulfill reservation' });
  }
});

// PUT /api/reservations/:id/cancel - cancel reservation
router.put('/:id/cancel', async (req, res) => {
  try {
    const id = req.params.id;
    const reason = req.body.reason || req.body.cancelReason || 'Cancelled by user';
    const now = getDubaiTime().toISOString();

    const updateData = {
      status: 'CANCELLED',
      cancelReason: reason,
      cancelledAt: now,
      updatedAt: now,
    };

    let updated = null;
    try {
      updated = await updateRow('reservations', id, updateData);
    } catch (dbErr) {
      if (isTableMissingError(dbErr)) {
        const idx = _fallbackReservations.findIndex((r) => r.id === id || r.reservationId === id);
        if (idx >= 0) {
          _fallbackReservations[idx] = { ..._fallbackReservations[idx], ...updateData };
          updated = _fallbackReservations[idx];
        }
      } else {
        throw dbErr;
      }
    }

    const populated = await populateReservations(updated ? [updated] : []);
    res.json(populated[0] || { success: true });
  } catch (err) {
    console.error('Cancel reservation error:', err);
    res.status(400).json({ error: err.message || 'Failed to cancel reservation' });
  }
});

// DELETE /api/reservations/:id - delete reservation
router.delete('/:id', checkPermission('editTransactions'), async (req, res) => {
  try {
    const id = req.params.id;
    try {
      await deleteRow('reservations', id);
    } catch (dbErr) {
      if (isTableMissingError(dbErr)) {
        _fallbackReservations = _fallbackReservations.filter((r) => r.id !== id && r.reservationId !== id);
      } else {
        throw dbErr;
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete reservation error:', err);
    res.status(400).json({ error: err.message || 'Failed to delete reservation' });
  }
});

module.exports = router;
