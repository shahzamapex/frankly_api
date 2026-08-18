const express = require('express');
const multer = require('multer');
const {
  ID_COLUMN,
  deleteRow,
  fetchById,
  fetchMany,
  hasColumn,
  indexById,
  insertRow,
  uniqueIds,
} = require('../lib/db');
const { uploadBufferToCloudinary } = require('../utils/cloudinary');
const checkPermission = require('../middlewares/checkPermission');
const { recalculateInventoryStocks } = require('../lib/stock');
const { normalizeTransactionType } = require('../lib/transactionType');

const router = express.Router();

const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'image/jpeg',
      'image/png',
      'image/jpg',
      'image/gif',
      'image/webp',
      'application/pdf',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  },
});

const getDubaiTime = () => new Date(new Date().getTime() + 4 * 60 * 60 * 1000);

function normalizeSiteLabel(site) {
  const siteCode = String(site?.siteCode || '').trim().toUpperCase();
  const siteName = String(site?.siteName || site?.name || '').trim().toUpperCase();
  return siteCode === 'WAREHOUSE' || siteName === 'WAREHOUSE';
}

async function resolveWarehouseSiteId() {
  const sites = await fetchMany('sites');
  const warehouseSite = sites.find(normalizeSiteLabel);
  return warehouseSite ? String(warehouseSite.id || warehouseSite._id || '') : null;
}

function getTransactionEmployeeId(transaction) {
  return transaction.employeeId || transaction.employee_id || transaction.employee || null;
}

async function fetchUserSummaries(ids) {
  const userIds = uniqueIds(ids);
  if (!userIds.length) {
    return new Map();
  }

  const users = await fetchMany('users', {
    filters: [{ column: ID_COLUMN, operator: 'in', value: userIds }],
  });

  return indexById(users.map((user) => ({
    id: user.id || user._id,
    username: user.username,
    fullName: user.fullName,
  })));
}

function readItemId(item) {
  if (!item) {
    return null;
  }

  if (typeof item.itemName === 'object') {
    return item.itemName.id || item.itemName._id || null;
  }

  return item.itemName || item.inventoryId || item.itemId || item.id || null;
}

function parseAmount(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeIsoDate(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeItems(items) {
  const source = typeof items === 'string' ? JSON.parse(items) : items;
  if (!Array.isArray(source)) {
    return [];
  }

  return source
    .map((item) => ({
      inventoryId: readItemId(item),
      quantity: Number(item?.quantity || 0),
    }))
    .filter((item) => item.inventoryId && item.quantity > 0);
}

async function uploadInvoice(req, body) {
  try {
    if (req.file) {
      body.invoiceImage = await uploadBufferToCloudinary(
        req.file.buffer,
        req.file.originalname || 'invoice',
      );
    } else if (body.invoiceBase64) {
      const buffer = Buffer.from(body.invoiceBase64, 'base64');
      body.invoiceImage = await uploadBufferToCloudinary(buffer, 'invoice');
    }
  } catch (error) {
    console.error('CDN upload failed:', error.message);
    if (req.file) {
      body.invoiceImage = req.file.buffer.toString('base64');
    } else if (body.invoiceBase64) {
      body.invoiceImage = body.invoiceBase64;
    }
  }
}

async function generateDeliveryId() {
  const supportsDeliveryId = await hasColumn('transactions', 'deliveryId');
  if (!supportsDeliveryId) {
    throw new Error('transactions.delivery_id column is required');
  }

  const now = getDubaiTime();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const prefix = `DEL-${dd}${mm}${yyyy}-`;

  const latest = await fetchMany('transactions', {
    filters: [
      { column: 'type', operator: 'eq', value: 'DELIVERY' },
      { column: 'deliveryId', operator: 'like', value: `${prefix}%` },
    ],
    orderBy: 'deliveryId',
    ascending: false,
    limit: 1,
  });

  let nextNum = 1;
  if (latest[0]?.deliveryId) {
    const match = latest[0].deliveryId.match(/-(\d+)$/);
    if (match) {
      nextNum = Number.parseInt(match[1], 10) + 1;
    }
  }

  return `${prefix}${String(nextNum).padStart(4, '0')}`;
}

function transactionTimestampValue(transaction) {
  const value =
    transaction?.deliveryDate ||
    transaction?.eventTimestamp ||
    transaction?.timestamp ||
    null;
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function transactionIdentityValue(transaction) {
  return String(
    transaction?.transactionId ||
      transaction?.deliveryId ||
      transaction?.id ||
      transaction?._id ||
      '',
  );
}

function isLaterTransaction(candidate, currentTimestamp, excludedIds) {
  const candidateTimestamp = transactionTimestampValue(candidate);
  if (candidateTimestamp !== currentTimestamp) {
    return candidateTimestamp > currentTimestamp;
  }

  const candidateId = String(candidate.id || candidate._id || '');
  if (excludedIds.has(candidateId)) {
    return false;
  }

  return transactionIdentityValue(candidate) > Array.from(excludedIds).sort()[0];
}

function inventoryStockSignatureFromRows(rows) {
  return rows
    .filter((row) => row.inventoryId)
    .map((row) => `${row.inventoryId}:${Number(row.quantity || 0)}`)
    .sort();
}

function inventoryStockSignatureFromItems(items) {
  return items
    .filter((item) => item.inventoryId)
    .map((item) => `${item.inventoryId}:${Number(item.quantity || 0)}`)
    .sort();
}

async function hasLaterNonDeliveryMovement(itemIds, referenceTimestamp, excludedIds) {
  const ids = uniqueIds(itemIds);
  if (!ids.length) {
    return false;
  }

  const relatedTransactions = await fetchMany('transactions', {
    filters: [{ column: 'inventoryId', operator: 'in', value: ids }],
  });

  return relatedTransactions.some((transaction) => {
    const transactionId = String(transaction.id || transaction._id || '');
    if (excludedIds.has(transactionId)) {
      return false;
    }

    if (normalizeTransactionType(transaction.type) === 'DELIVERY') {
      return false;
    }

    return isLaterTransaction(transaction, referenceTimestamp, excludedIds);
  });
}

async function getDeliveryColumnSupport() {
  const columns = await Promise.all([
    hasColumn('transactions', 'deliveryId'),
    hasColumn('transactions', 'deliveryDate'),
    hasColumn('transactions', 'seller'),
    hasColumn('transactions', 'amount'),
    hasColumn('transactions', 'invoiceImage'),
    hasColumn('transactions', 'invoiceNumber'),
    hasColumn('transactions', 'notes'),
    hasColumn('transactions', 'toSiteId'),
    hasColumn('transactions', 'proofImage'),
    hasColumn('transactions', 'employeeId'),
    hasColumn('transactions', 'employee'),
  ]);

  return {
    deliveryId: columns[0],
    deliveryDate: columns[1],
    seller: columns[2],
    amount: columns[3],
    invoiceImage: columns[4],
    invoiceNumber: columns[5],
    notes: columns[6],
    toSiteId: columns[7],
    proofImage: columns[8],
    employeeId: columns[9],
    employee: columns[10],
  };
}

async function buildDeliveryTransactionPayloads({
  body,
  items,
  deliveryId,
}) {
  const columnSupport = await getDeliveryColumnSupport();
  const warehouseSiteId = await resolveWarehouseSiteId();
  if (!columnSupport.deliveryId) {
    throw new Error('transactions.delivery_id column is required');
  }

  const deliveryDateIso =
    normalizeIsoDate(body.deliveryDate) || getDubaiTime().toISOString();
  const amount = parseAmount(body.amount);
  const receivedByEmployeeId = body.employee || body.receivedByEmployeeId || null;
  const sharedFields = {
    type: 'DELIVERY',
    eventTimestamp: deliveryDateIso,
    deliveryId,
    ...(columnSupport.deliveryDate ? { deliveryDate: deliveryDateIso } : {}),
    ...(columnSupport.seller ? { seller: body.seller?.trim() || null } : {}),
    ...(columnSupport.amount ? { amount } : {}),
    ...(columnSupport.employeeId && receivedByEmployeeId
      ? { employeeId: receivedByEmployeeId }
      : columnSupport.employee && receivedByEmployeeId
          ? { employee: receivedByEmployeeId }
          : {}),
    ...(columnSupport.invoiceImage
      ? { invoiceImage: body.invoiceImage || null }
      : {}),
    ...(columnSupport.invoiceNumber
      ? { invoiceNumber: body.invoiceNumber?.trim() || null }
      : {}),
    ...(columnSupport.notes
      ? { notes: body.remarks?.trim() || null }
      : {}),
    ...(columnSupport.proofImage
      ? { proofImage: body.proofImage || null }
      : {}),
  };

  return items.map((item, index) => ({
    transactionId: `${deliveryId}-${String(index + 1).padStart(2, '0')}`,
    ...sharedFields,
    inventoryId: item.inventoryId,
    ...(columnSupport.toSiteId ? { toSiteId: warehouseSiteId } : {}),
    quantity: item.quantity,
  }));
}

async function fetchDeliveryRowsByDeliveryId(deliveryId) {
  if (!deliveryId) {
    return [];
  }

  return fetchMany('transactions', {
    filters: [
      { column: 'type', operator: 'eq', value: 'DELIVERY' },
      { column: 'deliveryId', operator: 'eq', value: deliveryId },
    ],
    orderBy: 'eventTimestamp',
    ascending: true,
  });
}

async function resolveDeliveryRows(identifier) {
  const byDeliveryId = await fetchDeliveryRowsByDeliveryId(identifier);
  if (byDeliveryId.length) {
    return byDeliveryId;
  }

  const row = await fetchById('transactions', identifier);
  if (!row || normalizeTransactionType(row.type) !== 'DELIVERY') {
    return [];
  }

  if (row.deliveryId) {
    return fetchDeliveryRowsByDeliveryId(row.deliveryId);
  }

  return [row];
}

async function populateDeliveriesFromRows(rows) {
  if (!rows.length) {
    return [];
  }

  const inventoryIds = uniqueIds(rows.map((row) => row.inventoryId));
  const employeeIds = uniqueIds(rows.map((row) => getTransactionEmployeeId(row)));
  const [inventory, employees] = await Promise.all([
    inventoryIds.length
      ? fetchMany('inventory', {
          filters: [{ column: ID_COLUMN, operator: 'in', value: inventoryIds }],
        })
      : [],
    fetchUserSummaries(employeeIds),
  ]);

  const inventoryMap = indexById(
    inventory.map((item) => ({
      id: item.id || item._id,
      name: item.name,
      sku: item.sku,
    })),
  );
  const grouped = new Map();
  for (const row of rows) {
    const groupId = String(row.deliveryId || row.id || row._id);
    const current = grouped.get(groupId) || [];
    current.push(row);
    grouped.set(groupId, current);
  }

  const deliveries = Array.from(grouped.entries()).map(([groupId, groupRows]) => {
    const sortedRows = [...groupRows].sort(
      (a, b) => transactionTimestampValue(a) - transactionTimestampValue(b),
    );
    const head = sortedRows[0];
    const receivedByEmployeeId = getTransactionEmployeeId(head);
    const receivedByEmployee = receivedByEmployeeId
      ? employees.get(String(receivedByEmployeeId))
      : null;

    return {
      id: groupId,
      deliveryId: head.deliveryId || groupId,
      deliveryDate: head.deliveryDate || head.eventTimestamp || null,
      seller: head.seller || null,
      amount: head.amount ?? null,
      receivedBy:
        receivedByEmployee?.fullName ||
        receivedByEmployee?.username ||
        null,
      employee: receivedByEmployeeId || null,
      remarks: head.notes || null,
      invoiceImage: head.invoiceImage || null,
      proofImage: head.proofImage || null,
      invoiceNumber: head.invoiceNumber || null,
      items: sortedRows.map((row) => ({
        itemName: inventoryMap.get(String(row.inventoryId)) || row.inventoryId,
        quantity: Number(row.quantity || 0),
      })),
    };
  });

  deliveries.sort((a, b) => {
    const aTime = a.deliveryDate ? new Date(a.deliveryDate).getTime() : 0;
    const bTime = b.deliveryDate ? new Date(b.deliveryDate).getTime() : 0;
    return bTime - aTime;
  });

  return deliveries;
}

async function populateDeliveryFromRows(rows) {
  const deliveries = await populateDeliveriesFromRows(rows);
  return deliveries[0] || null;
}

function normalizeBody(body) {
  const nextBody = { ...body };
  if (nextBody.deliveryDate && typeof nextBody.deliveryDate === 'string') {
    nextBody.deliveryDate = normalizeIsoDate(nextBody.deliveryDate);
  }
  if (typeof nextBody.amount !== 'undefined' && nextBody.amount !== '') {
    nextBody.amount = parseAmount(nextBody.amount);
  }
  if (typeof nextBody.invoiceImage === 'string' && nextBody.invoiceImage === '') {
    nextBody.invoiceImage = null;
  }
  return nextBody;
}

async function insertDeliveryTransactions({ body, items, deliveryId }) {
  const payloads = await buildDeliveryTransactionPayloads({
    body,
    items,
    deliveryId,
  });
  return Promise.all(payloads.map((payload) => insertRow('transactions', payload)));
}

router.post(
  '/',
  checkPermission('addDeliveries'),
  (req, res, next) => {
    upload.single('invoice')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      const body = normalizeBody({ ...req.body });
      await uploadInvoice(req, body);
      const items = normalizeItems(body.items);
      if (!items.length) {
        return res.status(400).json({ error: 'Delivery must have at least one item' });
      }

      const deliveryId = await generateDeliveryId();
      const createdRows = await insertDeliveryTransactions({
        body,
        items,
        deliveryId,
      });

      recalculateInventoryStocks(items.map((item) => item.inventoryId)).catch((err) =>
        console.error('Background stock recalc error:', err),
      );

      const populated = await populateDeliveryFromRows(createdRows);
      res.status(201).json(populated);
    } catch (err) {
      console.error('Create delivery error:', err);
      res.status(400).json({ error: err.message || 'Failed to create delivery' });
    }
  },
);

router.get('/', checkPermission('viewDeliveries'), async (req, res) => {
  try {
    const rows = await fetchMany('transactions', {
      filters: [{ column: 'type', operator: 'eq', value: 'DELIVERY' }],
      orderBy: 'eventTimestamp',
      ascending: false,
    });
    res.json(await populateDeliveriesFromRows(rows));
  } catch (err) {
    console.error('Get deliveries error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', checkPermission('viewDeliveries'), async (req, res) => {
  try {
    const rows = await resolveDeliveryRows(req.params.id);
    if (!rows.length) {
      return res.status(404).json({ error: 'Delivery not found' });
    }
    res.json(await populateDeliveryFromRows(rows));
  } catch (err) {
    console.error('Get delivery error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put(
  '/:id',
  checkPermission('editDeliveries'),
  (req, res, next) => {
    upload.single('invoice')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      const existingRows = await resolveDeliveryRows(req.params.id);
      if (!existingRows.length) {
        return res.status(404).json({ error: 'Delivery not found' });
      }

      const body = normalizeBody({ ...req.body });
      await uploadInvoice(req, body);
      const items = normalizeItems(body.items);
      if (!items.length) {
        return res.status(400).json({ error: 'Delivery must have at least one item' });
      }

      const existingInventorySignature = inventoryStockSignatureFromRows(existingRows);
      const nextInventorySignature = inventoryStockSignatureFromItems(items);
      const inventoryRowsChanged =
        existingInventorySignature.length !== nextInventorySignature.length ||
        existingInventorySignature.some((value, index) => value !== nextInventorySignature[index]);

      const existingIds = new Set(
        existingRows.map((row) => String(row.id || row._id || '')),
      );
      const deliveryTimestamp = transactionTimestampValue(existingRows[0]);
      const affectedItemIds = uniqueIds([
        ...existingRows.map((row) => row.inventoryId),
        ...items.map((item) => item.inventoryId),
      ]);

      if (
        inventoryRowsChanged &&
        await hasLaterNonDeliveryMovement(
          affectedItemIds,
          deliveryTimestamp,
          existingIds,
        )
      ) {
        return res.status(409).json({
          error:
            'Cannot change delivery items because newer stock movement exists for one or more delivered items.',
        });
      }

      const deliveryId = existingRows[0].deliveryId || req.params.id;
      for (const row of existingRows) {
        await deleteRow('transactions', row.id || row._id);
      }

      const createdRows = await insertDeliveryTransactions({
        body: {
          seller: body.seller ?? existingRows[0].seller,
          amount: body.amount ?? existingRows[0].amount,
          employee:
            body.employee ??
            body.receivedByEmployeeId ??
            getTransactionEmployeeId(existingRows[0]),
          deliveryDate:
            body.deliveryDate ||
            existingRows[0].deliveryDate ||
            existingRows[0].eventTimestamp,
          remarks:
            body.remarks ??
            existingRows[0].notes,
          invoiceImage:
            body.invoiceImage !== undefined
              ? body.invoiceImage
              : existingRows[0].invoiceImage,
          invoiceNumber:
            body.invoiceNumber ?? existingRows[0].invoiceNumber,
        },
        items,
        deliveryId,
      });

      await recalculateInventoryStocks(affectedItemIds);
      res.json(await populateDeliveryFromRows(createdRows));
    } catch (err) {
      console.error('Update delivery error:', err);
      res.status(400).json({ error: err.message || 'Failed to update delivery' });
    }
  },
);

router.delete('/:id', checkPermission('deleteDeliveries'), async (req, res) => {
  try {
    const existingRows = await resolveDeliveryRows(req.params.id);
    if (!existingRows.length) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    const existingIds = new Set(
      existingRows.map((row) => String(row.id || row._id || '')),
    );
    const affectedItemIds = uniqueIds(existingRows.map((row) => row.inventoryId));
    const deliveryTimestamp = transactionTimestampValue(existingRows[0]);

    if (
      await hasLaterNonDeliveryMovement(
        affectedItemIds,
        deliveryTimestamp,
        existingIds,
      )
    ) {
      return res.status(409).json({
        error:
          'Cannot delete this delivery because newer stock movement exists for one or more delivered items.',
      });
    }

    await Promise.all(existingRows.map((row) => deleteRow('transactions', row.id || row._id)));
    recalculateInventoryStocks(affectedItemIds).catch((err) =>
      console.error('Background stock recalc error:', err),
    );
    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('Delete delivery error:', err);
    res.status(400).json({ error: err.message || 'Failed to delete delivery' });
  }
});

module.exports = router;
