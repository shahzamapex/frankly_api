const express = require('express');
const { fetchById, fetchMany, insertRow, updateRow, deleteRow, countRows } = require('../lib/db');
const checkPermission = require('../middlewares/checkPermission');

const router = express.Router();

function sanitizeVendorPayload(body) {
  const payload = { ...body };
  delete payload.id;
  delete payload._id;
  delete payload.created_at;
  delete payload.updated_at;
  delete payload.createdAt;
  delete payload.updatedAt;

  if (payload.name) {
    payload.name = String(payload.name).trim();
  }
  if (payload.type) {
    payload.type = String(payload.type).trim().toLowerCase();
  }
  if (payload.status) {
    payload.status = String(payload.status).trim().toLowerCase();
  }
  return payload;
}

// GET all vendors
router.get('/', checkPermission('viewTransactions'), async (req, res) => {
  try {
    const vendors = await fetchMany('vendors', {
      orderBy: 'name',
      ascending: true,
    });
    res.json(vendors);
  } catch (err) {
    console.error('Get vendors error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET vendor by ID
router.get('/:id', checkPermission('viewTransactions'), async (req, res) => {
  try {
    const vendor = await fetchById('vendors', req.params.id);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    res.json(vendor);
  } catch (err) {
    console.error('Get vendor error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST new vendor
router.post('/', checkPermission('manageInventory'), async (req, res) => {
  try {
    if (!req.body.name || !String(req.body.name).trim()) {
      return res.status(400).json({ error: 'Vendor name is required' });
    }

    const payload = sanitizeVendorPayload(req.body);
    if (!payload.type) {
      payload.type = 'both';
    }
    if (!payload.status) {
      payload.status = 'active';
    }

    const vendor = await insertRow('vendors', payload);
    res.status(201).json(vendor);
  } catch (err) {
    console.error('Create vendor error:', err);
    res.status(400).json({ error: 'Failed to create vendor' });
  }
});

// PUT update vendor
router.put('/:id', checkPermission('manageInventory'), async (req, res) => {
  try {
    const existing = await fetchById('vendors', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Vendor not found' });

    const payload = sanitizeVendorPayload(req.body);
    const updated = await updateRow('vendors', req.params.id, payload);
    if (!updated) return res.status(404).json({ error: 'Vendor not found' });

    res.json(updated);
  } catch (err) {
    console.error('Update vendor error:', err);
    res.status(400).json({ error: 'Failed to update vendor' });
  }
});

// DELETE vendor
router.delete('/:id', checkPermission('manageInventory'), async (req, res) => {
  try {
    const existing = await fetchById('vendors', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Vendor not found' });

    await deleteRow('vendors', req.params.id);
    res.json({ success: true, message: 'Vendor deleted successfully' });
  } catch (err) {
    console.error('Delete vendor error:', err);
    res.status(400).json({ error: 'Failed to delete vendor' });
  }
});

module.exports = router;
