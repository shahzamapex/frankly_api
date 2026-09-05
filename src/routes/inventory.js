const express = require('express');
const multer = require('multer');
const { fetchById, fetchMany, deleteRow, hasColumn, insertRow, updateRow } = require('../lib/db');
const { uploadBufferToCloudinary } = require('../utils/cloudinary');
const checkPermission = require('../middlewares/checkPermission');
const {
  _buildInventoryLocationState,
  recalculateAllInventoryStock: recalculateAllInventoryStockShared,
  recalculateInventoryStock: recalculateInventoryStockShared,
} = require('../lib/stock');
const { logAudit } = require('../lib/auditLogger');

const router = express.Router();

const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file) return cb(null, true);
    const allowed = ['image/jpeg', 'image/png', 'image/jpg', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

function parseNumber(value) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeLocation(value) {
  const normalized = String(value || '').trim();
  return normalized || 'Warehouse';
}

function normalizeSiteLabel(site) {
  const siteType = String(site?.type || '').trim().toUpperCase();
  const siteName = String(site?.siteName || site?.site_name || site?.name || '').trim().toUpperCase();
  const siteCode = String(site?.siteCode || site?.site_code || '').trim().toUpperCase();
  return siteType === 'WAREHOUSE' || siteName === 'WAREHOUSE' || siteName === 'WH' || siteCode === 'WAREHOUSE' || siteCode === 'WH';
}

async function resolveWarehouseSite() {
  const sites = await fetchMany('sites');
  return sites.find(normalizeSiteLabel) || null;
}

async function populateInventoryLocations(items) {
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) {
    return [];
  }

  try {
    const itemIds = list.map((item) => String(item.id || item._id || '')).filter(Boolean);
    const [sites, allTransactions] = await Promise.all([
      fetchMany('sites').catch(() => []),
      itemIds.length
        ? fetchMany('transactions', {
            filters: [{ column: 'inventoryId', operator: 'in', value: itemIds }],
          }).catch(() => [])
        : Promise.resolve([]),
    ]);

    const transactions = (allTransactions || []).filter((tx) => {
      const txItemId = String(tx.inventoryId || '');
      return itemIds.includes(txItemId);
    });

    const locationState = _buildInventoryLocationState(list, transactions, sites);

    return list.map((item) => {
      const itemId = String(item.id || item._id || '');
      const state = locationState.get(itemId);
      const fallbackLocation = state?.location || item.location || 'Warehouse';

      return {
        ...item,
        location: fallbackLocation,
        locationBreakdown: Array.isArray(state?.locationBreakdown) ? state.locationBreakdown : [],
        locationSiteId: state?.locationSiteId || item.locationSiteId || null,
      };
    });
  } catch (err) {
    console.error('Error populating inventory locations:', err);
    return list.map((item) => ({
      ...item,
      location: item.location || 'Warehouse',
      locationBreakdown: [],
    }));
  }
}

async function buildInventoryLocationPayload(body, existing = null) {
  const explicitLocationSiteId = body.locationSiteId || body.location_site_id || null;
  const fallbackLocation = normalizeLocation(body.location ?? existing?.location ?? 'Warehouse');
  let selectedSite = null;

  if (explicitLocationSiteId) {
    selectedSite = await fetchById('sites', explicitLocationSiteId);
    if (!selectedSite) {
      throw new Error('Selected location site not found');
    }
  } else if (fallbackLocation.toUpperCase() === 'WAREHOUSE') {
    selectedSite = await resolveWarehouseSite();
  }

  return {
    locationSiteId: selectedSite ? String(selectedSite.id || selectedSite._id || '') : null,
  };
}

function normalizeInventoryPayload(body) {
  const payload = { ...body };

  if (payload.itemName && !payload.name) {
    payload.name = payload.itemName;
  }

  const rawImages = payload.images || payload.image_urls || payload.imageUrl || payload.image_url || payload.image || null;
  if (rawImages) {
    if (Array.isArray(rawImages)) {
      payload.imageUrl = rawImages.length > 0
        ? (rawImages.length === 1 ? rawImages[0] : JSON.stringify(rawImages))
        : null;
    } else {
      payload.imageUrl = String(rawImages);
    }
  }

  delete payload.itemName;
  delete payload.images;
  delete payload.image_urls;
  delete payload.image_url;
  delete payload.image;
  delete payload.imageBase64;
  delete payload.imageContentType;

  if (payload.barcode && !payload.sku) {
    payload.sku = payload.barcode;
  }

  if (payload.certification?.safetyStandards && !payload.safetyStandards) {
    payload.safetyStandards = payload.certification.safetyStandards;
  }

  delete payload.certification;
  delete payload.barcode;

  const numericFields = [
    'initialStock',
    'currentStock',
  ];

  for (const field of numericFields) {
    const parsed = parseNumber(payload[field]);
    if (parsed !== undefined) {
      payload[field] = parsed;
    } else if (payload[field] === '') {
      delete payload[field];
    }
  }

  return payload;
}

async function recalculateInventoryStock(itemId, initialStockOverride) {
  return recalculateInventoryStockShared(itemId, initialStockOverride);
}

async function recalculateAllInventoryStock() {
  return recalculateAllInventoryStockShared();
}

async function uploadInventoryImage(req, body) {
  if (body.image && !body.imageUrl) {
    body.imageUrl = body.image;
  }

  try {
    if (req.file) {
      body.imageUrl = await uploadBufferToCloudinary(req.file.buffer, req.file.originalname || 'image');
    } else if (body.imageBase64) {
      const buffer = Buffer.from(body.imageBase64, 'base64');
      body.imageUrl = await uploadBufferToCloudinary(buffer, 'image');
    }
  } catch (error) {
    console.error('CDN upload failed:', error.message);
    if (req.file) body.imageUrl = req.file.buffer.toString('base64');
    else if (body.imageBase64) body.imageUrl = body.imageBase64;
  }
}

/**
 * @swagger
 * tags:
 *   name: Inventory
 *   description: Inventory management
 */

/**
 * @swagger
 * /inventory:
 *   get:
 *     summary: Get all inventory items
 *     tags: [Inventory]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of inventory items
 *   post:
 *     summary: Create inventory item
 *     tags: [Inventory]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - itemName
 *               - sku
 *               - category
 *             properties:
 *               itemName:
 *                 type: string
 *               sku:
 *                 type: string
 *               category:
 *                 type: string
 *               currentStock:
 *                 type: number
 *     responses:
 *       201:
 *         description: Item created
 */

router.post('/', checkPermission('addInventory'), (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err && err.message !== 'Invalid file type') return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    const body = { ...req.body };

    await uploadInventoryImage(req, body);

    const data = normalizeInventoryPayload(body);
    delete data.currentStock;

    if (!data.name || !data.sku || !data.category) {
      return res.status(400).json({ error: 'Item name, SKU, and category are required' });
    }

    Object.assign(data, await buildInventoryLocationPayload(body));

    data.currentStock = Number(data.initialStock || 0);

    const inventory = await insertRow('inventories', data);
    const [populated] = await populateInventoryLocations(inventory);

    logAudit({
      action: 'ADD_INVENTORY',
      entityType: 'inventory',
      entityId: inventory.id || inventory._id,
      user: req.user,
      req,
      previousValue: null,
      newValue: populated || inventory,
      details: `Added inventory item: ${inventory.name || data.name} (SKU: ${inventory.sku || data.sku}) with initial stock ${data.initialStock || 0}`,
    }).catch((err) => console.error('[AuditLog] Add inventory log error:', err));

    res.status(201).json(populated);
  } catch (err) {
    console.error('Create inventory error:', err);
    res.status(400).json({ error: 'Failed to create inventory item' });
  }
});

router.get('/', checkPermission('viewInventory'), async (req, res) => {
  try {
    const filters = [];

    if (req.query.type && typeof req.query.type === 'string') filters.push({ column: 'type', operator: 'eq', value: req.query.type });
    if (req.query.origin && typeof req.query.origin === 'string') filters.push({ column: 'origin', operator: 'eq', value: req.query.origin });
    if (req.query.category && typeof req.query.category === 'string') filters.push({ column: 'category', operator: 'eq', value: req.query.category });
    if (req.query.search && typeof req.query.search === 'string') {
      filters.push({ operator: 'or', value: `name.ilike.%${req.query.search}%,sku.ilike.%${req.query.search}%` });
    }

    const sortBy = typeof req.query.sortBy === 'string' ? req.query.sortBy : 'createdAt';
    const ascending = req.query.sortOrder === 'asc';
    let list = [];

    try {
      list = await fetchMany('inventories', { filters, orderBy: sortBy, ascending });
    } catch (fetchErr) {
      console.warn('fetchMany with orderBy failed, retrying without orderBy:', fetchErr.message || fetchErr);
      list = await fetchMany('inventories', { filters });
    }

    res.json(await populateInventoryLocations(list));
  } catch (err) {
    console.error('Get inventory error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

router.get('/barcode/:barcode', checkPermission('viewInventory'), async (req, res) => {
  try {
    const inventory = await fetchMany('inventories', {
      filters: [{ column: 'sku', operator: 'eq', value: req.params.barcode }],
      limit: 1,
    });
    const item = inventory[0];
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const [populated] = await populateInventoryLocations(item);
    res.json(populated);
  } catch (err) {
    console.error('Barcode search error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/sku/:sku', checkPermission('viewInventory'), async (req, res) => {
  try {
    const inventory = await fetchMany('inventories', {
      filters: [{ column: 'sku', operator: 'eq', value: req.params.sku }],
      limit: 1,
    });
    const item = inventory[0];
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const [populated] = await populateInventoryLocations(item);
    res.json(populated);
  } catch (err) {
    console.error('SKU search error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', checkPermission('viewInventory'), async (req, res) => {
  try {
    const inventory = await fetchById('inventories', req.params.id);
    if (!inventory) return res.status(404).json({ error: 'Inventory item not found' });
    const [populated] = await populateInventoryLocations(inventory);
    res.json(populated);
  } catch (err) {
    console.error('Get inventory item error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', checkPermission('editInventory'), (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err && err.message !== 'Invalid file type') return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  try {
    const body = { ...req.body };
    const existing = await fetchById('inventories', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Inventory item not found' });

    await uploadInventoryImage(req, body);

    const shouldClearImage = typeof body.imageUrl === 'string' && body.imageUrl === '';
    const data = normalizeInventoryPayload(body);
    if (shouldClearImage) {
      data.imageUrl = null;
    }

    const oldInitial = Number(existing.initialStock ?? existing.initial_stock ?? 0);
    const newInitial = data.initialStock !== undefined ? Number(data.initialStock) : oldInitial;
    const delta = newInitial - oldInitial;
    const oldCurrent = Number(existing.currentStock ?? existing.current_stock ?? oldInitial);
    data.currentStock = Math.max(0, oldCurrent + delta);

    Object.assign(data, await buildInventoryLocationPayload(body, existing));

    const updated = await updateRow('inventories', req.params.id, data);
    if (!updated) return res.status(404).json({ error: 'Inventory item not found' });

    const [populated] = await populateInventoryLocations(updated);

    logAudit({
      action: 'EDIT_INVENTORY',
      entityType: 'inventory',
      entityId: req.params.id,
      user: req.user,
      req,
      previousValue: existing,
      newValue: populated || updated,
      details: `Edited inventory item: ${updated.name || existing.name} (SKU: ${updated.sku || existing.sku})`,
    }).catch((err) => console.error('[AuditLog] Edit inventory log error:', err));

    res.json(populated);
  } catch (err) {
    console.error('Update inventory error:', err);
    res.status(400).json({ error: err.message || 'Failed to update inventory item' });
  }
});

router.patch('/:id', checkPermission('editInventory'), async (req, res) => {
  try {
    const allowedFields = ['status', 'remark'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields provided' });
    }

    const existing = await fetchById('inventories', req.params.id);
    const updated = await updateRow('inventories', req.params.id, updates);
    if (!updated) return res.status(404).json({ error: 'Inventory item not found' });
    const [populated] = await populateInventoryLocations(updated);

    logAudit({
      action: 'EDIT_INVENTORY',
      entityType: 'inventory',
      entityId: req.params.id,
      user: req.user,
      req,
      previousValue: existing,
      newValue: populated || updated,
      details: `Edited inventory item (partial): ${updated.name || existing?.name} (${Object.keys(updates).join(', ')})`,
    }).catch((err) => console.error('[AuditLog] Patch inventory log error:', err));

    res.json(populated);
  } catch (err) {
    console.error('Patch inventory error:', err);
    res.status(400).json({ error: 'Failed to update inventory item' });
  }
});

router.delete('/:id', checkPermission('deleteInventory'), async (req, res) => {
  try {
    const item = await fetchById('inventories', req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    await deleteRow('inventories', req.params.id);

    logAudit({
      action: 'DELETE_INVENTORY',
      entityType: 'inventory',
      entityId: req.params.id,
      user: req.user,
      req,
      previousValue: item,
      newValue: null,
      details: `Deleted inventory item: ${item.name} (SKU: ${item.sku})`,
    }).catch((err) => console.error('[AuditLog] Delete inventory log error:', err));

    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('Delete inventory error:', err);
    res.status(400).json({ error: 'Failed to delete inventory item' });
  }
});

router.post('/:id/recalculate', checkPermission('viewInventory'), async (req, res) => {
  try {
    const item = await fetchById('inventories', req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const currentStock = await recalculateInventoryStock(req.params.id, item.initialStock);

    res.json({ currentStock });
  } catch (err) {
    console.error('Recalculate stock error:', err);
    res.status(500).json({ error: 'Failed to recalculate stock' });
  }
});

router.post('/recalculate-all', checkPermission('viewInventory'), async (req, res) => {
  try {
    const result = await recalculateAllInventoryStock();

    res.json(result);
  } catch (err) {
    console.error('Recalculate all stock error:', err);
    res.status(500).json({ error: 'Failed to recalculate all stock' });
  }
});

module.exports = router;
