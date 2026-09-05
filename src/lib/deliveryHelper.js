const {
  ID_COLUMN,
  fetchById,
  fetchMany,
  hasColumn,
  indexById,
  uniqueIds,
} = require('./db');
const { uploadBufferToCloudinary } = require('../utils/cloudinary');
const { normalizeTransactionType } = require('./transactionType');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const getDubaiTime = () => new Date(new Date().getTime() + 4 * 60 * 60 * 1000);

function formatDateTimeStamp(date = getDubaiTime()) {
  const d = date instanceof Date ? date : new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dd}${mm}${yy}${hh}${min}${ss}`;
}

function generateTransactionId(timestamp) {
  const now = timestamp ? new Date(timestamp) : getDubaiTime();
  return `TXN-${formatDateTimeStamp(now)}`;
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

function transactionTimestampValue(transaction) {
  const value =
    transaction?.createdAt ||
    transaction?.created_at ||
    transaction?.timestamp ||
    transaction?.deliveryDate ||
    null;
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
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

async function fetchDeliveryRowsByTransactionId(txnId) {
  if (!txnId) {
    return [];
  }

  const hasTxnIdCol = await hasColumn('transactions', 'transactionId');
  if (!hasTxnIdCol) return [];

  return fetchMany('transactions', {
    filters: [
      { column: 'type', operator: 'eq', value: 'DELIVERY' },
      { column: 'transactionId', operator: 'eq', value: txnId },
    ],
    orderBy: 'createdAt',
    ascending: true,
  });
}

async function resolveDeliveryRows(identifier) {
  const byTxnId = await fetchDeliveryRowsByTransactionId(identifier);
  if (byTxnId.length) {
    return byTxnId;
  }

  if (await hasColumn('transactions', 'batchId')) {
    const byBatchId = await fetchMany('transactions', {
      filters: [
        { column: 'type', operator: 'eq', value: 'DELIVERY' },
        { column: 'batchId', operator: 'eq', value: identifier },
      ],
      orderBy: 'createdAt',
      ascending: true,
    });
    if (byBatchId.length) {
      return byBatchId;
    }
  }

  const idStr = String(identifier || '').trim();
  if (!UUID_REGEX.test(idStr)) {
    return [];
  }

  const row = await fetchById('transactions', idStr);
  if (!row || normalizeTransactionType(row.type) !== 'DELIVERY') {
    return [];
  }

  if (row.transactionId) {
    const rows = await fetchDeliveryRowsByTransactionId(row.transactionId);
    if (rows.length) return rows;
  }
  if (row.batchId) {
    const rows = await resolveDeliveryRows(row.batchId);
    if (rows.length) return rows;
  }

  return [row];
}

async function populateDeliveriesFromRows(rows) {
  if (!rows.length) {
    return [];
  }

  const inventoryIds = uniqueIds(rows.map((row) => row.inventoryId));
  const employeeIds = uniqueIds(rows.map((row) => getTransactionEmployeeId(row)));
  const [inventory, employees, sites] = await Promise.all([
    inventoryIds.length
      ? fetchMany('inventories', {
          filters: [{ column: ID_COLUMN, operator: 'in', value: inventoryIds }],
        })
      : [],
    fetchUserSummaries(employeeIds),
    fetchMany('sites').catch(() => []),
  ]);

  const siteMap = indexById(
    sites.map((s) => {
      const rawName = String(s.siteName || s.name || s.site_name || '').trim();
      return {
        id: s.id || s._id,
        siteName: rawName || 'Warehouse',
        type: s.type || 'PROJECT',
      };
    }),
  );

  const warehouseSite = sites.find((s) => {
    const t = String(s.type || '').toUpperCase();
    const n = String(s.siteName || s.site_name || s.name || '').toUpperCase();
    return t === 'WAREHOUSE' || n === 'WAREHOUSE' || n === 'WH';
  });
  const defaultWarehouseName = warehouseSite?.siteName || warehouseSite?.name || 'Warehouse';
  const defaultWarehouseId = warehouseSite ? (warehouseSite.id || warehouseSite._id) : null;

  const inventoryMap = indexById(
    inventory.map((item) => ({
      id: item.id || item._id,
      name: item.name,
      sku: item.sku,
    })),
  );
  const grouped = new Map();
  for (const row of rows) {
    const groupId = String(
      row.batchId ||
      row.batch_id ||
      row.transactionId ||
      row.transaction_id ||
      row.deliveryId ||
      row.delivery_id ||
      row.id ||
      row._id
    );
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
        const rowNotes = row.remark || row.remarks || row.notes || '';
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
        const rowNotes = row.remark || row.remarks || row.notes || '';
        if (rowNotes.includes('[invoice:')) {
          const match = rowNotes.match(/\[invoice:(.*?)\]/);
          if (match && match[1]) {
            invoiceImage = match[1];
            break;
          }
        }
      }
    }

    let cleanRemarks = (head.remark || head.remarks || head.notes || '')
      .replace(/\[proof:.*?\]/g, '')
      .replace(/\[PROOF_IMAGE:.*?\]/g, '')
      .replace(/\[invoice:.*?\]/g, '')
      .trim();
    if (!cleanRemarks) cleanRemarks = null;

    const fromSiteId = head.fromSiteId || head.from_site_id || null;
    const toSiteId = head.toSiteId || head.to_site_id || head.siteId || head.site_id || defaultWarehouseId;
    const resolvedToSite = toSiteId ? siteMap.get(String(toSiteId)) : null;
    const toSiteName = resolvedToSite?.siteName || defaultWarehouseName;

    const refKey =
      head.transactionId ||
      head.transaction_id ||
      head.batchId ||
      head.batch_id ||
      groupId;

    return {
      id: groupId,
      transactionId: refKey,
      deliveryId: refKey,
      batchId: refKey,
      createdAt: head.createdAt || head.created_at || head.timestamp || head.deliveryDate || null,
      deliveryDate: head.createdAt || head.created_at || head.timestamp || head.deliveryDate || null,
      seller: head.seller || null,
      fromSiteId,
      vendorId: fromSiteId,
      fromSite: fromSiteId,
      toSiteId: toSiteId || null,
      toSite: toSiteName,
      toSiteName: toSiteName,
      site: toSiteName,
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
      items: sortedRows.map((row) => {
        const itemSiteId = row.toSiteId || row.to_site_id || row.siteId || row.site_id || toSiteId;
        const itemSite = itemSiteId ? siteMap.get(String(itemSiteId)) : null;
        const itemSiteName = itemSite?.siteName || toSiteName;
        return {
          itemName: inventoryMap.get(String(row.inventoryId)) || row.inventoryId,
          quantity: Number(row.quantity || 0),
          site: itemSiteName,
          siteName: itemSiteName,
          toSite: itemSiteName,
          toSiteName: itemSiteName,
          siteId: itemSiteId || null,
          toSiteId: itemSiteId || null,
        };
      }),
    };
  });

  deliveries.sort((a, b) => {
    const aTime = a.createdAt || a.deliveryDate ? new Date(a.createdAt || a.deliveryDate).getTime() : 0;
    const bTime = b.createdAt || b.deliveryDate ? new Date(b.createdAt || b.deliveryDate).getTime() : 0;
    return bTime - aTime;
  });

  return deliveries;
}

module.exports = {
  uploadInvoice,
  normalizeItems,
  inventoryStockSignatureFromRows,
  inventoryStockSignatureFromItems,
  fetchDeliveryRowsByTransactionId,
  resolveDeliveryRows,
  populateDeliveriesFromRows,
  generateTransactionId,
};
