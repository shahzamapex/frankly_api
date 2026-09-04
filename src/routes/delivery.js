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
const { recalculateInventoryStocks } = require('../lib/stock');
const { normalizeTransactionType } = require('../lib/transactionType');
const { logAudit } = require('../lib/auditLogger');
const checkPermission = require('../middlewares/checkPermission');

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

async function getLaterNonDeliveryMovements(itemIds, referenceTimestamp, excludedIds) {
  const ids = uniqueIds(itemIds);
  if (!ids.length) {
    return [];
  }

  const relatedTransactions = await fetchMany('transactions', {
    filters: [{ column: 'inventoryId', operator: 'in', value: ids }],
  });

  return relatedTransactions
    .filter((transaction) => {
      const transactionId = String(transaction.id || transaction._id || '');
      if (excludedIds.has(transactionId)) {
        return false;
      }

      if (normalizeTransactionType(transaction.type) === 'DELIVERY') {
        return false;
      }

      return isLaterTransaction(transaction, referenceTimestamp, excludedIds);
    })
    .sort((a, b) => (isLaterTransaction(a, b) ? -1 : 1));
}

async function hasLaterNonDeliveryMovement(itemIds, referenceTimestamp, excludedIds) {
  const later = await getLaterNonDeliveryMovements(itemIds, referenceTimestamp, excludedIds);
  return later.length > 0;
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
    hasColumn('transactions', 'fromSiteId'),
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
    fromSiteId: columns[8],
    proofImage: columns[9],
    employeeId: columns[10],
    employee: columns[11],
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

  let fromSiteId =
    body.fromSiteId ||
    body.fromSite ||
    body.vendorId ||
    body.vendor ||
    body.supplierId ||
    body.supplier ||
    null;

  if (!fromSiteId && body.seller && typeof body.seller === 'string') {
    const rawSeller = body.seller.trim();
    const sites = await fetchMany('sites').catch(() => []);
    const matchedSupplier = sites.find(
      (s) =>
        String(s.id) === rawSeller ||
        String(s.siteName || '').trim().toLowerCase() === rawSeller.toLowerCase() ||
        String(s.siteCode || '').trim().toLowerCase() === rawSeller.toLowerCase(),
    );
    if (matchedSupplier) {
      fromSiteId = String(matchedSupplier.id);
    }
  }

  const deliveryDateIso =
    normalizeIsoDate(body.deliveryDate) || getDubaiTime().toISOString();
  const amount = parseAmount(body.amount);
  const receivedByEmployeeId = body.employee || body.receivedByEmployeeId || null;
  let rawProof =
    body.proofImages ||
    body.proof_images ||
    body.proofImage ||
    body.proof_image ||
    null;
  if (typeof rawProof === 'string' && rawProof.startsWith('[') && rawProof.endsWith(']')) {
    try {
      rawProof = JSON.parse(rawProof);
    } catch (_) {}
  }
  let proofUrl = null;
  if (Array.isArray(rawProof)) {
    const validItems = rawProof.filter(Boolean);
    proofUrl = validItems.length > 0 ? (validItems.length === 1 ? validItems[0] : JSON.stringify(validItems)) : null;
  } else if (rawProof && typeof rawProof === 'string' && rawProof.trim().length > 0) {
    proofUrl = rawProof.trim();
  }

  let notesValue = body.remarks?.trim() || body.notes?.trim() || null;
  const invoiceVal = body.invoiceImage || body.invoice_image || null;
  if (!columnSupport.proofImage && proofUrl) {
    notesValue = notesValue ? `${notesValue} [proof:${proofUrl}]` : `[proof:${proofUrl}]`;
  }
  if (!columnSupport.invoiceImage && invoiceVal) {
    notesValue = notesValue ? `${notesValue} [invoice:${invoiceVal}]` : `[invoice:${invoiceVal}]`;
  }

  const sharedFields = {
    type: 'DELIVERY',
    eventTimestamp: deliveryDateIso,
    deliveryId,
    ...(columnSupport.deliveryDate ? { deliveryDate: deliveryDateIso } : {}),
    ...(columnSupport.seller ? { seller: body.seller?.trim() || null } : {}),
    ...(columnSupport.fromSiteId && fromSiteId ? { fromSiteId } : {}),
    ...(columnSupport.amount ? { amount } : {}),
    ...(columnSupport.employeeId && receivedByEmployeeId
      ? { employeeId: receivedByEmployeeId }
      : columnSupport.employee && receivedByEmployeeId
          ? { employee: receivedByEmployeeId }
          : {}),
    ...(columnSupport.invoiceImage
      ? { invoiceImage: invoiceVal }
      : {}),
    ...(columnSupport.invoiceNumber
      ? { invoiceNumber: body.invoiceNumber?.trim() || null }
      : {}),
    ...(columnSupport.notes
      ? { notes: notesValue }
      : {}),
    ...(columnSupport.proofImage && proofUrl
      ? { proofImage: proofUrl }
      : {}),
  };

  return items.map((item, index) => ({
    transactionId: `${deliveryId}-${String(index + 1).padStart(2, '0')}`,
    ...sharedFields,
    inventoryId: item.inventoryId,
    ...(columnSupport.toSiteId ? { toSiteId: warehouseSiteId } : {}),
    ...(columnSupport.fromSiteId && fromSiteId ? { fromSiteId } : {}),
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
      ? fetchMany('inventories', {
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
    const rawNotes = head.notes || '';
    let proofImages = [];
    const rawProofValues = sortedRows.map((r) => r.proofImage || r.proof_image).filter(Boolean);
    for (const val of rawProofValues) {
      if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
        try {
          const parsed = JSON.parse(val);
          if (Array.isArray(parsed)) {
            proofImages.push(...parsed.filter(Boolean));
          } else if (parsed) {
            proofImages.push(String(parsed));
          }
        } catch (_) {
          proofImages.push(val);
        }
      } else if (Array.isArray(val)) {
        proofImages.push(...val.filter(Boolean));
      } else if (typeof val === 'string' && val.trim().length > 0) {
        proofImages.push(val.trim());
      }
    }
    if (proofImages.length === 0) {
      for (const row of sortedRows) {
        const rowNotes = row.notes || '';
        if (rowNotes.includes('[proof:')) {
          const match = rowNotes.match(/\[proof:(.*?)\]/);
          if (match && match[1]) {
            try {
              const parsed = JSON.parse(match[1]);
              if (Array.isArray(parsed)) proofImages.push(...parsed.filter(Boolean));
              else if (parsed) proofImages.push(String(parsed));
            } catch (_) {
              if (match[1].trim().length > 0) proofImages.push(match[1].trim());
            }
          }
        }
        if (proofImages.length === 0 && rowNotes.includes('[PROOF_IMAGE:')) {
          const match = rowNotes.match(/\[PROOF_IMAGE:(.*?)\]/);
          if (match && match[1].trim().length > 0) proofImages.push(match[1].trim());
        }
        if (proofImages.length > 0) break;
      }
    }
    proofImages = Array.from(new Set(proofImages.map((s) => typeof s === 'string' ? s.trim() : s).filter(Boolean)));
    const proofImage = proofImages.length > 0 ? proofImages[0] : null;
    let invoiceImage = sortedRows.map((r) => r.invoiceImage || r.invoice_image).find(Boolean) || null;
    if (!invoiceImage) {
      for (const row of sortedRows) {
        const rowNotes = row.notes || '';
        if (rowNotes.includes('[invoice:')) {
          const match = rowNotes.match(/\[invoice:(.*?)\]/);
          if (match && match[1]) {
            invoiceImage = match[1];
            break;
          }
        }
      }
    }

    let cleanRemarks = (head.notes || '')
      .replace(/\[proof:.*?\]/g, '')
      .replace(/\[PROOF_IMAGE:.*?\]/g, '')
      .replace(/\[invoice:.*?\]/g, '')
      .trim();
    if (!cleanRemarks) cleanRemarks = null;

    const fromSiteId = head.fromSiteId || head.from_site_id || null;

    return {
      id: groupId,
      deliveryId: head.deliveryId || groupId,
      deliveryDate: head.deliveryDate || head.eventTimestamp || null,
      seller: head.seller || null,
      fromSiteId,
      vendorId: fromSiteId,
      fromSite: fromSiteId,
      amount: head.amount ?? null,
      receivedBy:
        receivedByEmployee?.fullName ||
        receivedByEmployee?.username ||
        null,
      employee: receivedByEmployeeId || null,
      remarks: cleanRemarks,
      invoiceImage,
      proofImage,
      proofImages,
      proof_images: proofImages,
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
  if (typeof nextBody.amount !== 'undefined') {
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

      if (Array.isArray(createdRows) && createdRows.length > 0) {
        for (const row of createdRows) {
          logAudit({
            action: 'ADD_TRANSACTION',
            entityType: 'transaction',
            entityId: row.id || row._id || row.transactionId,
            user: req.user,
            req,
            previousValue: null,
            newValue: row,
            details: `Added delivery transaction ${row.transactionId || ''}: DELIVERY (Qty: ${row.quantity}) for delivery ${deliveryId}`,
          }).catch((err) => console.error('[AuditLog] Delivery transaction log error:', err));
        }
      }

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

      if (inventoryRowsChanged) {
        for (const existingRow of existingRows) {
          const invId = existingRow.inventoryId;
          const oldQty = Number(existingRow.quantity) || 0;
          const matchingNewItem = items.find((i) => String(i.inventoryId) === String(invId));
          const newQty = matchingNewItem ? Number(matchingNewItem.quantity) || 0 : 0;

          if (newQty < oldQty) {
            const reduction = oldQty - newQty;
            const invRecord = await fetchById('inventories', invId);
            const currentStock = invRecord ? Number(invRecord.currentStock ?? invRecord.quantity ?? 0) : 0;
            const itemName = invRecord?.itemName || invRecord?.name || 'Delivered item';

            if (currentStock - reduction < 0) {
              const laterMovements = await getLaterNonDeliveryMovements([invId], deliveryTimestamp, existingIds);
              let movementDetail = '';
              if (laterMovements.length > 0) {
                let populated = [];
                try {
                  populated = await populateTransactions(laterMovements.slice(0, 1));
                } catch (_) {
                  populated = laterMovements;
                }
                const latest = populated[0] || laterMovements[0];
                const txNum = latest.transactionId || latest.id || 'N/A';
                const txType = (latest.type || 'Movement').replace(/_/g, ' ');
                const txQty = latest.quantity != null ? Number(latest.quantity) : 0;
                let dest = '';
                if (latest.toSite && typeof latest.toSite === 'object' && latest.toSite.siteName) {
                  dest = ` to ${latest.toSite.siteName}`;
                } else if (latest.site && typeof latest.site === 'object' && latest.site.siteName) {
                  dest = ` (${latest.site.siteName})`;
                } else if (latest.employee && typeof latest.employee === 'object' && (latest.employee.fullName || latest.employee.username)) {
                  dest = ` to ${latest.employee.fullName || latest.employee.username}`;
                }
                movementDetail = ` (Downstream Movement: #${txNum} - ${txType}, Qty: ${txQty}${dest})`;
              }

              const minAllowed = oldQty - Math.max(0, currentStock);
              return res.status(400).json({
                error: `Cannot reduce delivery quantity to ${newQty} for "${itemName}". Current warehouse stock is ${currentStock} because items have already been issued/consumed${movementDetail} (minimum allowed delivery qty: ${minAllowed}). Please edit or delete the downstream Issue/Movement transaction first.`,
              });
            }
          }
        }
      }

      const deliveryId = existingRows[0].deliveryId || req.params.id;
      for (const row of existingRows) {
        await deleteRow('transactions', row.id || row._id);
      }

      const createdRows = await insertDeliveryTransactions({
        body: {
          seller: body.seller !== undefined ? body.seller : existingRows[0].seller,
          fromSiteId:
            body.fromSiteId ||
            body.fromSite ||
            body.vendorId ||
            existingRows[0].fromSiteId ||
            existingRows[0].from_site_id ||
            null,
          amount: body.amount !== undefined ? body.amount : existingRows[0].amount,
          employee:
            body.employee ??
            body.receivedByEmployeeId ??
            getTransactionEmployeeId(existingRows[0]),
          deliveryDate:
            body.deliveryDate ||
            existingRows[0].deliveryDate ||
            existingRows[0].eventTimestamp,
          remarks:
            body.remarks !== undefined
              ? body.remarks
              : existingRows[0].notes,
          invoiceImage:
            body.invoiceImage !== undefined
              ? body.invoiceImage
              : existingRows[0].invoiceImage,
          invoiceNumber:
            body.invoiceNumber !== undefined
              ? body.invoiceNumber
              : existingRows[0].invoiceNumber,
          proofImage:
            body.proofImage !== undefined
              ? body.proofImage
              : (body.proof_image !== undefined ? body.proof_image : existingRows[0].proofImage),
          proofImages:
            body.proofImages !== undefined
              ? body.proofImages
              : (body.proof_images !== undefined ? body.proof_images : undefined),
        },
        items,
        deliveryId,
      });

      await recalculateInventoryStocks(affectedItemIds);
      const populated = await populateDeliveryFromRows(createdRows);

      logAudit({
        action: 'EDIT_DELIVERY',
        entityType: 'delivery',
        entityId: deliveryId,
        user: req.user,
        req,
        previousValue: existingRows,
        newValue: populated,
        details: `Edited delivery ${deliveryId} (${items.length} items)`,
      }).catch((err) => console.error('[AuditLog] Edit delivery log error:', err));

      res.json(populated);
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

    const laterMovements = await getLaterNonDeliveryMovements(
      affectedItemIds,
      deliveryTimestamp,
      existingIds,
    );

    if (laterMovements.length > 0) {
      const latest = laterMovements[0];
      const txNumber = latest.transactionId || latest.id || 'N/A';
      const txType = (latest.type || 'Movement').replace(/_/g, ' ');
      const txQty = latest.quantity != null ? Number(latest.quantity) : 0;
      const dateVal = latest.eventTimestamp || latest.timestamp || latest.createdAt;
      const dateStr = dateVal
        ? new Date(dateVal).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        : '';
      const datePart = dateStr ? ` on ${dateStr}` : '';

      return res.status(409).json({
        error: `Cannot delete: Newer stock movement exists for delivered item (#${txNumber} - ${txType}${txQty > 0 ? `, Qty: ${txQty}` : ''}${datePart}). Delete #${txNumber} first.`,
      });
    }

    await Promise.all(existingRows.map((row) => deleteRow('transactions', row.id || row._id)));
    recalculateInventoryStocks(affectedItemIds).catch((err) =>
      console.error('Background stock recalc error:', err),
    );

    const deliveryId = existingRows[0]?.deliveryId || req.params.id;
    logAudit({
      action: 'DELETE_DELIVERY',
      entityType: 'delivery',
      entityId: deliveryId,
      user: req.user,
      req,
      previousValue: existingRows,
      newValue: null,
      details: `Deleted delivery ${deliveryId} (${existingRows.length} item rows)`,
    }).catch((err) => console.error('[AuditLog] Delete delivery log error:', err));

    res.json({ message: 'Deleted' });
  } catch (err) {
    console.error('Delete delivery error:', err);
    res.status(400).json({ error: err.message || 'Failed to delete delivery' });
  }
});

module.exports = router;
