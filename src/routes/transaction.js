const express = require('express');
const multer = require('multer');
const { ID_COLUMN, fetchById, fetchOne, fetchMany, deleteRow, deleteRows, hasColumn, indexById, insertRow, insertRows, uniqueIds, updateRow, resolveIdColumn } = require('../lib/db');
const { recalculateInventoryStocks } = require('../lib/stock');
const { VALID_TRANSACTION_TYPES, normalizeTransactionType } = require('../lib/transactionType');
const { logAudit } = require('../lib/auditLogger');
const checkPermission = require('../middlewares/checkPermission');
const {
  populateDeliveriesFromRows,
  resolveDeliveryRows,
  normalizeItems,
  inventoryStockSignatureFromRows,
  inventoryStockSignatureFromItems,
  uploadInvoice,
} = require('../lib/deliveryHelper');

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

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fetchTransactionByIdentifier(identifier) {
  const idStr = String(identifier || '').trim();
  if (!idStr) return null;
  if (UUID_REGEX.test(idStr)) {
    const row = await fetchById('transactions', idStr);
    if (row) return row;
  }
  if (await hasColumn('transactions', 'transactionId')) {
    const row = await fetchOne('transactions', {
      filters: [{ column: 'transactionId', operator: 'eq', value: idStr }],
    });
    if (row) return row;
  }
  return null;
}

const getDubaiTime = () => new Date(new Date().getTime() + (4 * 60 * 60 * 1000));

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

function normalizeSiteLabel(site) {
  const siteCode = String(site?.siteCode || '').trim().toUpperCase();
  const siteName = String(site?.siteName || site?.name || '').trim().toUpperCase();
  return siteCode === 'WAREHOUSE' || siteName === 'WAREHOUSE';
}

async function resolveWarehouseSiteId() {
  const sites = await fetchMany('sites').catch(() => []);
  const warehouseSite = sites.find((s) => {
    const t = String(s.type || '').toUpperCase();
    const c = String(s.siteCode || s.site_code || '').toUpperCase();
    const n = String(s.siteName || s.site_name || s.name || '').toUpperCase();
    return t === 'WAREHOUSE' || c === 'WAREHOUSE' || n === 'WAREHOUSE';
  });
  return warehouseSite ? String(warehouseSite.id || warehouseSite._id || '') : null;
}

async function resolveScrappedSiteId() {
  const sites = await fetchMany('sites').catch(() => []);
  const scrappedSite = sites.find((s) => {
    const t = String(s.type || '').toUpperCase();
    const c = String(s.siteCode || s.site_code || '').toUpperCase();
    const n = String(s.siteName || s.site_name || s.name || '').toUpperCase();
    return t === 'SCRAPPED' || t === 'SCRAP' || c === 'SCRAPPED' || c === 'SCRAP' || n === 'SCRAPPED' || n === 'SCRAP';
  });
  return scrappedSite ? String(scrappedSite.id || scrappedSite._id || '') : null;
}

async function getTransactionColumnSupport() {
  const columns = await Promise.all([
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
    hasColumn('transactions', 'signature_image'),
    hasColumn('transactions', 'returnCondition'),
  ]);

  return {
    deliveryDate: columns[0],
    seller: columns[1],
    amount: columns[2],
    invoiceImage: columns[3],
    invoiceNumber: columns[4],
    notes: columns[5],
    toSiteId: columns[6],
    fromSiteId: columns[7],
    proofImage: columns[8],
    employeeId: columns[9],
    employee: columns[10],
    signatureImage: columns[11],
    returnCondition: columns[12],
  };
}

function buildTransactionWritePayload(body, warehouseSiteId, scrappedSiteId, columnSupport = {}) {
  const normalizedType = normalizeTransactionType(body.type);
  const inputFromSite = body.fromSiteId || body.fromSite || body.vendorId || body.vendor || body.supplierId || body.supplier || null;
  const inputToSite = body.toSiteId || body.toSite || body.site || null;
  const inputEmployee = body.employeeId || body.employee || body.receivedByEmployeeId || null;

  let fromSiteId = inputFromSite;
  let toSiteId = inputToSite;

  switch (normalizedType) {
    case 'ISSUE_SITE':
      fromSiteId = inputFromSite || warehouseSiteId;
      toSiteId = inputToSite;
      break;
    case 'ISSUE_EMPLOYEE':
      fromSiteId = warehouseSiteId;
      toSiteId = null;
      break;
    case 'ISSUE_REPAIR':
      fromSiteId = warehouseSiteId;
      toSiteId = inputToSite;
      break;
    case 'ISSUE_SCRAP':
      fromSiteId = warehouseSiteId;
      toSiteId = scrappedSiteId;
      break;
    case 'RETURN_SITE':
      fromSiteId = inputFromSite;
      toSiteId = warehouseSiteId;
      break;
    case 'RETURN_EMPLOYEE':
      fromSiteId = null;
      toSiteId = warehouseSiteId;
      break;
    case 'RETURN_REPAIR':
      fromSiteId = inputFromSite;
      toSiteId = warehouseSiteId;
      break;
    case 'RETURN_NEW':
    case 'DELIVERY':
      fromSiteId = inputFromSite;
      toSiteId = inputToSite || warehouseSiteId;
      break;
    case 'SITE TRANSFER':
      fromSiteId = inputFromSite;
      toSiteId = inputToSite;
      break;
    default:
      break;
  }

  let notesValue = body.notes || body.remarks || body.returnDetails?.notes || null;
  const rawProof = body.proofImages || body.proof_images || body.proofImage || body.proof_image || null;
  let proofUrl = Array.isArray(rawProof)
    ? (rawProof.length > 0 ? (rawProof.length === 1 ? rawProof[0] : JSON.stringify(rawProof)) : null)
    : (rawProof ? String(rawProof) : null);
  const sigUrl = body.signatureImage || body.signature_image || null;
  const invoiceVal = body.invoiceImage || body.invoice_image || null;
  const invoiceNum = body.invoiceNumber || body.invoice_number || null;
  const sellerVal = body.seller ? String(body.seller).trim() : null;
  const amountVal = body.amount !== undefined && body.amount !== null && body.amount !== '' ? (Number(body.amount) || null) : null;
  const deliveryDateIso = body.deliveryDate ? (new Date(body.deliveryDate).toISOString()) : null;

  if (columnSupport.proofImage === false && proofUrl) {
    notesValue = notesValue ? `${notesValue} [proof:${proofUrl}]` : `[proof:${proofUrl}]`;
  }
  if (columnSupport.invoiceImage === false && invoiceVal) {
    notesValue = notesValue ? `${notesValue} [invoice:${invoiceVal}]` : `[invoice:${invoiceVal}]`;
  }
  if (columnSupport.signatureImage === false && sigUrl) {
    notesValue = notesValue ? `${notesValue} [SIGNATURE:${sigUrl}]` : `[SIGNATURE:${sigUrl}]`;
  }

  return {
    type: normalizedType,
    inventoryId: body.inventoryId || body.item || body.itemId,
    quantity: Number(body.quantity || 0),
    fromSiteId: fromSiteId || null,
    toSiteId: toSiteId || null,
    siteId: toSiteId || fromSiteId || null,
    employeeId: inputEmployee || null,
    returnCondition: body.returnCondition || body.returnDetails?.condition || null,
    notes: notesValue,
    ...(columnSupport.proofImage !== false && proofUrl ? { proofImage: proofUrl } : {}),
    ...(columnSupport.signatureImage !== false && sigUrl ? { signature_image: sigUrl } : {}),
    ...(columnSupport.seller !== false && sellerVal ? { seller: sellerVal } : {}),
    ...(columnSupport.amount !== false && amountVal !== null ? { amount: amountVal } : {}),
    ...(columnSupport.invoiceImage !== false && invoiceVal ? { invoiceImage: invoiceVal } : {}),
    ...(columnSupport.invoiceNumber !== false && invoiceNum ? { invoiceNumber: invoiceNum } : {}),
    ...(columnSupport.deliveryDate !== false && deliveryDateIso ? { deliveryDate: deliveryDateIso } : {}),
  };
}

async function populateTransactions(transactions) {
  if (!transactions.length) {
    return [];
  }

  const siteIds = uniqueIds([
    ...transactions.map((transaction) => transaction.fromSiteId || transaction.from_site_id),
    ...transactions.map((transaction) => transaction.toSiteId || transaction.to_site_id),
    ...transactions.map((transaction) => transaction.siteId || transaction.site_id),
  ]);
  const itemIds = uniqueIds(transactions.map((transaction) => transaction.inventoryId || transaction.inventory_id));
  const employeeIds = uniqueIds(transactions.map((transaction) => transaction.employeeId || transaction.employee_id));

  const [sites, items, employees] = await Promise.all([
    siteIds.length ? fetchMany('sites', { filters: [{ column: 'id', operator: 'in', value: siteIds }] }) : [],
    itemIds.length ? fetchMany('inventories', { filters: [{ column: 'id', operator: 'in', value: itemIds }] }) : [],
    fetchUserSummaries(employeeIds),
  ]);

  const siteMap = indexById(sites.map((site) => {
    const rawCode = String(site.siteCode || site.site_code || site.code || '').trim();
    const rawName = String(site.siteName || site.name || site.site_name || '').trim();
    const displayLabel = rawName || rawCode || 'WH';
    return {
      id: site.id || site._id,
      siteName: displayLabel,
      siteCode: rawCode || displayLabel,
      type: site.type || 'PROJECT',
    };
  }));

  const itemMap = indexById(items.map((item) => ({
    id: item.id || item._id,
    name: item.name,
    sku: item.sku,
    unitOfMeasure: item.unitOfMeasure || item.unit_of_measure || item.uom || item.unit || '',
  })));

  return transactions.map((transaction) => {
    const employeeId = transaction.employeeId || transaction.employee_id;
    const employee = employeeId ? (employees.get(String(employeeId)) || employeeId) : null;
    const fromSiteId = transaction.fromSiteId || transaction.from_site_id;
    const toSiteId = transaction.toSiteId || transaction.to_site_id;
    const legacySiteId = transaction.siteId || transaction.site_id;
    const fromSite = fromSiteId ? (siteMap.get(String(fromSiteId)) || fromSiteId) : null;
    const toSite = toSiteId ? (siteMap.get(String(toSiteId)) || toSiteId) : null;
    const legacySite = legacySiteId ? (siteMap.get(String(legacySiteId)) || legacySiteId) : null;
    const compatibilitySite = toSite || fromSite || legacySite;

    const normalizedType = normalizeTransactionType(transaction.type);
    let resolvedFromSite = fromSite;
    let resolvedToSite = toSite;
    if (normalizedType === 'ISSUE_SCRAP' || transaction.type === 'ISSUE_SCRAP') {
      if (fromSiteId && toSiteId && String(fromSiteId) === String(toSiteId)) {
        const whSite = Array.from(siteMap.values()).find((s) => s.type === 'WAREHOUSE' || s.siteCode === 'WAREHOUSE' || s.siteName === 'WAREHOUSE');
        resolvedFromSite = whSite || { id: 'warehouse', siteName: 'WH', siteCode: 'WH', type: 'WAREHOUSE' };
      }
    }

    let proofImage = transaction.proofImage || transaction.proof_image || null;
    let signatureImage = transaction.signatureImage || transaction.signature_image || null;
    let rawNotes = transaction.notes || null;

    if (rawNotes && typeof rawNotes === 'string') {
      if (!proofImage && rawNotes.includes('[PROOF_IMAGE:')) {
        const match = rawNotes.match(/\[PROOF_IMAGE:([^\]]+)\]/);
        if (match) {
          proofImage = match[1];
        }
      }
      if (!signatureImage && rawNotes.includes('[SIGNATURE:')) {
        const match = rawNotes.match(/\[SIGNATURE:([^\]]+)\]/);
        if (match) {
          signatureImage = match[1];
        }
      }
      rawNotes = rawNotes
        .replace(/\[PROOF_IMAGE:[^\]]+\]/g, '')
        .replace(/\[SIGNATURE:[^\]]+\]/g, '')
        .trim();
      if (!rawNotes) rawNotes = null;
    }

    return ({
      ...transaction,
      transactionId: transaction.transactionId || null,
      seller: transaction.seller || null,
      amount: transaction.amount ?? null,
      invoiceImage: transaction.invoiceImage || transaction.invoice_image || null,
      invoiceNumber: transaction.invoiceNumber || transaction.invoice_number || null,
      deliveryDate: transaction.deliveryDate || transaction.delivery_date || transaction.eventTimestamp || null,
      employee,
      fromSite: resolvedFromSite,
      toSite: resolvedToSite,
      site: compatibilitySite,
      item: transaction.inventoryId ? (itemMap.get(String(transaction.inventoryId)) || transaction.inventoryId) : transaction.inventoryId,
      unitOfMeasure: (transaction.inventoryId && itemMap.get(String(transaction.inventoryId))?.unitOfMeasure) || transaction.unitOfMeasure || transaction.unit_of_measure || transaction.uom || '',
      timestamp: transaction.eventTimestamp || transaction.timestamp,
      proofImage,
      signatureImage,
      returnDetails: (transaction.returnCondition || rawNotes)
        ? {
          condition: transaction.returnCondition || '',
          notes: rawNotes,
        }
        : null,
    });
  });
}

async function populateTransaction(transaction) {
  const populated = await populateTransactions(transaction ? [transaction] : []);
  return populated[0] || null;
}

function formatDateTimeStamp(date = getDubaiTime()) {
  const d = date instanceof Date ? date : new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}${mm}${yy}${hh}${min}`;
}

function generateTransactionId(timestamp) {
  const now = timestamp ? new Date(timestamp) : getDubaiTime();
  return `TXN-${formatDateTimeStamp(now)}`;
}

function validateTransactionInput(body) {
  const normalizedType = normalizeTransactionType(body?.type);
  const item = body?.item;
  const quantity = Number(body?.quantity);
  const fromSite = body?.fromSite || body?.fromSiteId || body?.site || null;
  const toSite = body?.toSite || body?.toSiteId || body?.site || null;

  if (!normalizedType || !item || !quantity || quantity <= 0) {
    return 'Invalid input data';
  }

  if (!VALID_TRANSACTION_TYPES.includes(normalizedType)) {
    return 'Invalid transaction type';
  }

  if (normalizedType === 'ISSUE' && !toSite) {
    return 'Site is required for issue transactions';
  }

  if (normalizedType === 'DELIVERY' && !body?.item) {
    return 'Item is required for delivery transactions';
  }

  if (normalizedType === 'RETURN' && !fromSite && !body?.employee) {
    return 'Site or employee is required for return transactions';
  }

  if (normalizedType === 'EMPLOYEE ISSUE' && !body?.employee) {
    return 'Employee is required for employee issue transactions';
  }

  if (normalizedType === 'SITE TRANSFER') {
    if (!fromSite || !toSite) {
      return 'Source and destination sites are required for site transfer transactions';
    }
    if (String(fromSite) === String(toSite)) {
      return 'Source and destination sites must be different';
    }
  }

  return null;
}

function transactionTimestampValue(transaction) {
  const value = transaction?.eventTimestamp || transaction?.timestamp || null;
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function transactionIdentityValue(transaction) {
  return String(
    transaction?.transactionId ||
    transaction?.id ||
    transaction?._id ||
    '',
  );
}

function isLaterTransaction(candidate, current) {
  const candidateTimestamp = transactionTimestampValue(candidate);
  const currentTimestamp = transactionTimestampValue(current);

  if (candidateTimestamp !== currentTimestamp) {
    return candidateTimestamp > currentTimestamp;
  }

  return transactionIdentityValue(candidate) >
    transactionIdentityValue(current);
}

function isStoredSiteTransferTransaction(transaction) {
  const type = normalizeTransactionType(transaction?.type);
  const notes = String(transaction?.notes || '').trim().toLowerCase();
  return (
    (type === 'RETURN' && notes.includes('site transfer to ')) ||
    (type === 'ISSUE' && notes.includes('site transfer from '))
  );
}

function transactionTouchesSite(transaction, siteId) {
  const normalizedSiteId = String(siteId || '');
  if (!normalizedSiteId) {
    return false;
  }

  return [
    transaction.siteId,
    transaction.fromSiteId,
    transaction.toSiteId,
  ].some((value) => String(value || '') == normalizedSiteId);
}

async function getDeleteBlockReason(transaction) {
  if (isStoredSiteTransferTransaction(transaction)) {
    return {
      blocked: true,
      error: 'Site transfer transactions cannot be deleted individually.',
    };
  }

  const inventoryId = transaction?.inventoryId || null;
  if (!inventoryId) {
    return null;
  }

  const relatedTransactions = await fetchMany('transactions', {
    filters: [{ column: 'inventoryId', operator: 'eq', value: inventoryId }],
    orderBy: 'eventTimestamp',
    ascending: false,
    limit: 20,
  });
  const currentId = String(transaction.id || transaction._id || '');

  const laterMovements = relatedTransactions
    .filter((entry) => {
      const entryId = String(entry.id || entry._id || '');
      return entryId !== currentId && isLaterTransaction(entry, transaction);
    })
    .sort((a, b) => (isLaterTransaction(a, b) ? -1 : 1));

  if (laterMovements.length > 0) {
    let populatedLater = [];
    try {
      populatedLater = await populateTransactions(laterMovements.slice(0, 3));
    } catch (_) {
      populatedLater = [];
    }

    const latest = populatedLater[0] || laterMovements[0];
    const txId = latest.id || latest._id || '';
    const txNumber = latest.transactionId || txId || 'N/A';
    const txType = (latest.type || 'Movement').replace(/_/g, ' ');
    const txQty = latest.quantity != null ? Number(latest.quantity) : 0;

    let destinationOrSource = '';
    let siteName = '';
    if (latest.toSite && typeof latest.toSite === 'object' && latest.toSite.siteName) {
      siteName = latest.toSite.siteName;
      destinationOrSource = ` -> ${latest.toSite.siteName}`;
    } else if (latest.site && typeof latest.site === 'object' && latest.site.siteName) {
      siteName = latest.site.siteName;
      destinationOrSource = ` (${latest.site.siteName})`;
    } else if (latest.siteName) {
      siteName = latest.siteName;
      destinationOrSource = ` (${latest.siteName})`;
    } else if (latest.employee && typeof latest.employee === 'object' && (latest.employee.fullName || latest.employee.username)) {
      siteName = latest.employee.fullName || latest.employee.username;
      destinationOrSource = ` to ${siteName}`;
    }

    const dateVal = latest.eventTimestamp || latest.timestamp || latest.createdAt;
    const dateStr = dateVal
      ? new Date(dateVal).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      : '';
    const datePart = dateStr ? ` on ${dateStr}` : '';

    return {
      blocked: true,
      error: `Cannot delete: Newer movement exists for this item (#${txNumber} - ${txType}${txQty > 0 ? `, Qty: ${txQty}` : ''}${destinationOrSource}${datePart}). Delete #${txNumber} first.`,
      newerMovement: {
        id: txId,
        transactionId: txNumber,
        type: txType,
        siteName: siteName || 'N/A',
        quantity: txQty,
        date: dateStr,
      },
    };
  }

  return null;
}

async function getUpdateBlockReason(existing, patchPayload) {
  const existingType = normalizeTransactionType(existing?.type);
  const isIssue = existingType.startsWith('ISSUE') || existingType === 'ISSUE' || existingType === 'EMPLOYEE ISSUE';
  if (!isIssue) return null;

  const oldQty = Number(existing.quantity) || 0;
  const newQty = patchPayload.quantity !== undefined ? Number(patchPayload.quantity) : oldQty;
  if (newQty >= oldQty) return null;

  const inventoryId = existing.inventoryId || existing.inventory_id || existing.item;
  const siteId = existing.toSiteId || existing.siteId || existing.site || null;
  const employeeId = existing.employeeId || existing.employee || null;

  if (!inventoryId || (!siteId && !employeeId)) return null;

  const related = await fetchMany('transactions', {
    filters: [{ column: 'inventoryId', operator: 'eq', value: inventoryId }],
  }).catch(() => []);

  const currentId = String(existing.id || existing._id || '');
  let totalReturned = 0;
  let otherIssued = 0;

  for (const tx of related) {
    const txId = String(tx.id || tx._id || '');
    if (txId === currentId) continue;
    const txType = normalizeTransactionType(tx.type);
    const txQty = Number(tx.quantity) || 0;
    const fromSite = String(tx.fromSiteId || tx.fromSite || '');
    const toSite = String(tx.toSiteId || tx.toSite || '');
    const txSite = String(tx.siteId || tx.site || '');
    const txEmp = String(tx.employeeId || tx.employee || '');

    if (siteId) {
      const sId = String(siteId);
      const isFromSite = fromSite === sId || (txSite === sId && (txType.startsWith('RETURN') || txType === 'SITE TRANSFER' || txType.includes('SCRAP')));
      const isToSite = toSite === sId || (txSite === sId && (txType.startsWith('ISSUE') || txType === 'SITE TRANSFER'));

      if (isFromSite && (txType.startsWith('RETURN') || txType === 'SITE TRANSFER' || txType.includes('SCRAP'))) {
        totalReturned += txQty;
      }
      if (isToSite && (txType.startsWith('ISSUE') || txType === 'SITE TRANSFER')) {
        otherIssued += txQty;
      }
    } else if (employeeId) {
      const eId = String(employeeId);
      if (txEmp === eId) {
        if (txType.startsWith('RETURN')) {
          totalReturned += txQty;
        } else if (txType.startsWith('ISSUE')) {
          otherIssued += txQty;
        }
      }
    }
  }

  const newBalance = otherIssued + newQty - totalReturned;
  if (newBalance < 0) {
    const maxAllowedReduction = Math.max(0, oldQty + newBalance);
    return `Cannot reduce issue quantity to ${newQty}. Already returned/transferred ${totalReturned} unit(s) for this destination (maximum reduction possible: ${maxAllowedReduction}). Please edit or delete the Return transaction first.`;
  }

  return null;
}

router.get('/', checkPermission('viewTransactions'), async (req, res) => {
  try {
    if (String(req.query.type || '').toUpperCase() === 'DELIVERY') {
      const rows = await fetchMany('transactions', {
        filters: [{ column: 'type', operator: 'eq', value: 'DELIVERY' }],
        orderBy: 'eventTimestamp',
        ascending: false,
      });
      return res.json(await populateDeliveriesFromRows(rows));
    }

    const filters = [];
    const includeDelivery = String(req.query.includeDelivery || '')
      .trim()
      .toLowerCase() === 'true';
    const filterTxnId = req.query.transactionId;
    if (filterTxnId && typeof filterTxnId === 'string') {
      filters.push({ column: 'transactionId', operator: 'eq', value: filterTxnId });
    }
    if (req.query.type && typeof req.query.type === 'string') {
      filters.push({ column: 'type', operator: 'eq', value: req.query.type.toUpperCase() });
    }
    if (req.query.item && typeof req.query.item === 'string') filters.push({ column: 'inventoryId', operator: 'eq', value: req.query.item });
    if (req.query.employee && typeof req.query.employee === 'string') {
      if (await hasColumn('transactions', 'employeeId')) {
        filters.push({ column: 'employeeId', operator: 'eq', value: req.query.employee });
      } else if (await hasColumn('transactions', 'employee')) {
        filters.push({ column: 'employee', operator: 'eq', value: req.query.employee });
      } else {
        return res.json([]);
      }
    }

    const transactions = await fetchMany('transactions', {
      filters,
      orderBy: 'eventTimestamp',
      ascending: false,
    });

    const visibleTransactions = transactions.filter((transaction) => {
      if (!includeDelivery && !req.query.type && !filterTxnId && normalizeTransactionType(transaction.type) === 'DELIVERY') {
        return false;
      }
      if (req.query.site && typeof req.query.site === 'string') {
        return transactionTouchesSite(transaction, req.query.site);
      }
      return true;
    });

    res.json(await populateTransactions(visibleTransactions));
  } catch (err) {
    console.error('Get transactions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', checkPermission('viewTransactions'), async (req, res) => {
  try {
    if (req.params.id === 'deliveries') {
      const rows = await fetchMany('transactions', {
        filters: [{ column: 'type', operator: 'eq', value: 'DELIVERY' }],
        orderBy: 'eventTimestamp',
        ascending: false,
      });
      return res.json(await populateDeliveriesFromRows(rows));
    }

    const deliveryRows = await resolveDeliveryRows(req.params.id);
    if (deliveryRows.length > 0 && normalizeTransactionType(deliveryRows[0].type) === 'DELIVERY') {
      const populated = await populateDeliveriesFromRows(deliveryRows);
      return res.json(populated[0] || populated);
    }

    const transaction = await fetchTransactionByIdentifier(req.params.id);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
    res.json(await populateTransaction(transaction));
  } catch (err) {
    console.error('Get transaction error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post(
  '/',
  checkPermission('addTransactions'),
  (req, res, next) => {
    upload.single('invoice')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      const body = { ...req.body };
      await uploadInvoice(req, body);

      let items = body.items;
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch (_) {}
      }

      const isDelivery = normalizeTransactionType(body.type) === 'DELIVERY' || !!body.seller;
      const now = body.timestamp || body.deliveryDate ? new Date(body.timestamp || body.deliveryDate) : getDubaiTime();
      const eventTimestamp = now.toISOString();
      const columnSupport = await getTransactionColumnSupport();
      const [warehouseSiteId, scrappedSiteId] = await Promise.all([
        resolveWarehouseSiteId(),
        resolveScrappedSiteId(),
      ]);

      if (Array.isArray(items) && items.length > 0) {
        const normalizedItems = items.map((it) => ({
          inventoryId: it.inventoryId || it.item || it.itemId || it.itemName?.id || it.itemName,
          quantity: Number(it.quantity || 0),
        })).filter((it) => it.inventoryId && it.quantity > 0);

        if (!normalizedItems.length) {
          return res.status(400).json({ error: 'At least one item with valid quantity is required' });
        }

        const txnId = body.transactionId || generateTransactionId(now);

        const rowsToInsert = [];
        for (let i = 0; i < normalizedItems.length; i++) {
          const it = normalizedItems[i];
          const writePayload = buildTransactionWritePayload(
            {
              ...body,
              type: body.type || (isDelivery ? 'DELIVERY' : 'ISSUE'),
              inventoryId: it.inventoryId,
              quantity: it.quantity,
            },
            warehouseSiteId,
            scrappedSiteId,
            columnSupport,
          );

          rowsToInsert.push({
            transactionId: txnId,
            eventTimestamp,
            ...writePayload,
          });
        }

        const inserted = await insertRows('transactions', rowsToInsert);
        const affectedItemIds = uniqueIds(normalizedItems.map((it) => it.inventoryId));
        recalculateInventoryStocks(affectedItemIds).catch((err) =>
          console.error('Background stock recalc error:', err)
        );

        if (isDelivery) {
          const populatedDeliveries = await populateDeliveriesFromRows(inserted);
          return res.status(201).json(populatedDeliveries[0] || inserted);
        }

        const populated = await populateTransactions(inserted);
        return res.status(201).json(populated);
      }

      // Single item transaction / delivery
      const validationError = validateTransactionInput(body);
      if (validationError && !isDelivery) {
        return res.status(400).json({ error: validationError });
      }

      const itemId = body.inventoryId || body.item || body.itemId;
      const existingItem = await fetchById('inventories', itemId);
      if (!existingItem) {
        return res.status(404).json({ error: 'Item not found' });
      }

      const txnId = body.transactionId || generateTransactionId(now);

      const writePayload = buildTransactionWritePayload(
        {
          ...body,
          type: body.type || (isDelivery ? 'DELIVERY' : 'ISSUE'),
          inventoryId: itemId,
        },
        warehouseSiteId,
        scrappedSiteId,
        columnSupport,
      );

      const transaction = await insertRow('transactions', {
        transactionId: txnId,
        eventTimestamp,
        ...writePayload,
      });

      recalculateInventoryStocks([itemId]).catch((err) =>
        console.error('Background stock recalc error:', err)
      );

      const populated = await populateTransaction(transaction);
      res.status(201).json(populated);
    } catch (err) {
      console.error('Create transaction error:', err);
      res.status(400).json({ error: err.message || 'Failed to create transaction' });
    }
  },
);

router.post('/bulk', checkPermission('addTransactions'), async (req, res) => {
  try {
    const source = Array.isArray(req.body?.transactions) ? req.body.transactions : [];
    if (!source.length) {
      return res.status(400).json({ error: 'At least one transaction is required' });
    }

    const normalized = source.map((body) => {
      const type = normalizeTransactionType(body?.type);
      const item = body?.item;
      const quantity = Number(body?.quantity);
      return { body, type, item, quantity };
    });

    for (const entry of normalized) {
      const validationError = validateTransactionInput(entry.body);
      if (validationError) {
        return res.status(400).json({ error: validationError });
      }
    }

    const itemIds = uniqueIds(normalized.map((entry) => entry.item));
    const existingItems = await fetchMany('inventories', {
      filters: [{ column: 'id', operator: 'in', value: itemIds }],
    });
    const existingItemIds = new Set(existingItems.map((item) => String(item.id || item._id)));
    if (itemIds.some((itemId) => !existingItemIds.has(String(itemId)))) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const [warehouseSiteId, scrappedSiteId] = await Promise.all([
      resolveWarehouseSiteId(),
      resolveScrappedSiteId(),
    ]);
    const deliveryTimestamp = normalized[0]?.body?.timestamp;
    const now = deliveryTimestamp ? new Date(deliveryTimestamp) : getDubaiTime();
    const eventTimestamp = now.toISOString();

    const txnId = req.body?.transactionId || normalized[0]?.body?.transactionId || generateTransactionId(now);

    const columnSupport = await getTransactionColumnSupport();

    const rowsToInsert = [];
    for (let index = 0; index < normalized.length; index++) {
      const entry = normalized[index];
      const writePayload = buildTransactionWritePayload(
        entry.body,
        entry.body.warehouseSite || warehouseSiteId,
        scrappedSiteId,
        columnSupport,
      );
      rowsToInsert.push({
        transactionId: txnId,
        eventTimestamp: entry.body.timestamp || eventTimestamp,
        ...writePayload,
      });
    }

    const createdTransactions = await insertRows('transactions', rowsToInsert);
    recalculateInventoryStocks(itemIds).catch((err) => console.error('Background stock recalc error:', err));
    const populated = await populateTransactions(createdTransactions);

    if (Array.isArray(populated) && populated.length > 0) {
      for (const itemTx of populated) {
        logAudit({
          action: 'ADD_TRANSACTION',
          entityType: 'transaction',
          entityId: itemTx.id || itemTx._id || itemTx.transactionId,
          user: req.user,
          req,
          previousValue: null,
          newValue: itemTx,
          details: `Added transaction ${itemTx.transactionId || ''}: ${itemTx.type} (Qty: ${itemTx.quantity})`,
        }).catch((err) => console.error('[AuditLog] Bulk add transaction log error:', err));
      }
    }

    res.status(201).json(populated);
  } catch (err) {
    console.error('Create bulk transactions error:', err);
    const status = err.message === 'Item not found' ? 404 : 500;
    res.status(status).json({ error: status === 404 ? 'Item not found' : 'Internal server error' });
  }
});

router.put(
  '/:id',
  checkPermission('editTransactions'),
  (req, res, next) => {
    upload.single('invoice')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  },
  async (req, res) => {
    try {
      const existingRows = await resolveDeliveryRows(req.params.id);
      if (existingRows.length > 0 && normalizeTransactionType(existingRows[0].type) === 'DELIVERY') {
        const body = { ...req.body };
        await uploadInvoice(req, body);
        let items = body.items;
        if (typeof items === 'string') {
          try { items = JSON.parse(items); } catch (_) {}
        }
        items = normalizeItems(items);
        if (!items.length) {
          return res.status(400).json({ error: 'Delivery must have at least one item' });
        }

        const existingInventorySignature = inventoryStockSignatureFromRows(existingRows);
        const nextInventorySignature = inventoryStockSignatureFromItems(items);
        const inventoryRowsChanged =
          existingInventorySignature.length !== nextInventorySignature.length ||
          existingInventorySignature.some((value, index) => value !== nextInventorySignature[index]);

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
                const minAllowed = oldQty - Math.max(0, currentStock);
                return res.status(400).json({
                  error: `Cannot reduce delivery quantity to ${newQty} for "${itemName}". Current warehouse stock is ${currentStock} because items have already been issued/consumed (minimum allowed: ${minAllowed}). Please edit or delete the downstream Issue transaction first.`,
                });
              }
            }
          }
        }

        const now = body.deliveryDate ? new Date(body.deliveryDate) : getDubaiTime();
        const eventTimestamp = now.toISOString();
        const txnId = existingRows[0].transactionId || generateTransactionId(now);
        const columnSupport = await getTransactionColumnSupport();
        const [warehouseSiteId, scrappedSiteId] = await Promise.all([
          resolveWarehouseSiteId(),
          resolveScrappedSiteId(),
        ]);

        for (const row of existingRows) {
          await deleteRow('transactions', row.id || row._id);
        }

        const rowsToInsert = [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const writePayload = buildTransactionWritePayload(
            {
              seller: body.seller !== undefined ? body.seller : existingRows[0].seller,
              fromSiteId: body.fromSiteId || body.fromSite || existingRows[0].fromSiteId || null,
              amount: body.amount !== undefined ? body.amount : existingRows[0].amount,
              employee: body.employee ?? body.receivedByEmployeeId ?? (existingRows[0].employeeId || existingRows[0].employee),
              deliveryDate: body.deliveryDate || existingRows[0].deliveryDate || existingRows[0].eventTimestamp,
              remarks: body.remarks !== undefined ? body.remarks : existingRows[0].notes,
              invoiceImage: body.invoiceImage !== undefined ? body.invoiceImage : existingRows[0].invoiceImage,
              invoiceNumber: body.invoiceNumber !== undefined ? body.invoiceNumber : existingRows[0].invoiceNumber,
              proofImage: body.proofImage !== undefined ? body.proofImage : existingRows[0].proofImage,
              type: 'DELIVERY',
              inventoryId: it.inventoryId,
              quantity: it.quantity,
            },
            warehouseSiteId,
            scrappedSiteId,
            columnSupport,
          );

          rowsToInsert.push({
            transactionId: txnId,
            eventTimestamp,
            ...writePayload,
          });
        }

        const createdRows = await insertRows('transactions', rowsToInsert);
        await recalculateInventoryStocks(affectedItemIds);
        const populated = await populateDeliveriesFromRows(createdRows);
        return res.json(populated[0] || populated);
      }

      return res.status(403).json({
        error: 'Direct transaction editing is disabled to maintain inventory ledger integrity. Please delete the transaction and create a new one if an adjustment is required.',
      });
    } catch (err) {
      console.error('Update transaction error:', err);
      res.status(400).json({ error: err.message || 'Failed to update transaction' });
    }
  },
);

router.post('/bulk-delete', checkPermission('deleteTransactions'), async (req, res) => {
  try {
    const rawIds = Array.isArray(req.body.ids) ? req.body.ids : [];
    const ids = uniqueIds(rawIds);
    if (!ids.length) {
      return res.status(400).json({ error: 'No transaction IDs provided' });
    }

    const idColumn = resolveIdColumn('transactions');
    const existing = await fetchMany('transactions', {
      filters: [{ column: idColumn, operator: 'in', value: ids }],
    });

    if (Array.isArray(existing) && existing.length > 1) {
      existing.sort((a, b) => {
        const typeA = normalizeTransactionType(a.type);
        const typeB = normalizeTransactionType(b.type);
        const isReturnA = typeA.startsWith('RETURN') || typeA === 'SITE_TRANSFER' || typeA.includes('SCRAP');
        const isReturnB = typeB.startsWith('RETURN') || typeB === 'SITE_TRANSFER' || typeB.includes('SCRAP');

        if (isReturnA && !isReturnB) return -1;
        if (!isReturnA && isReturnB) return 1;

        const dateA = new Date(a.eventTimestamp || a.timestamp || a.createdAt || 0).getTime();
        const dateB = new Date(b.eventTimestamp || b.timestamp || b.createdAt || 0).getTime();
        return dateB - dateA;
      });
    }

    const sortedIds = (Array.isArray(existing) && existing.length > 0)
      ? existing.map((t) => t.id || t._id).filter(Boolean)
      : ids;

    const deleted = await deleteRows('transactions', sortedIds.length ? sortedIds : ids);
    const inventoryIds = uniqueIds(
      existing.map((t) => t.inventoryId || t.inventory_id || t.item || t.itemId).filter(Boolean)
    );

    if (inventoryIds.length > 0) {
      recalculateInventoryStocks(inventoryIds).catch((err) =>
        console.error('Stock recalc error on bulk delete:', err)
      );
    }

    if (Array.isArray(existing) && existing.length > 0) {
      for (const tx of existing) {
        logAudit({
          action: 'DELETE_TRANSACTION',
          entityType: 'transaction',
          entityId: tx.id || tx._id || tx.transactionId,
          user: req.user,
          req,
          previousValue: tx,
          newValue: null,
          details: `Deleted transaction: ${tx.transactionId || tx.id} (${tx.type}, Qty: ${tx.quantity})`,
        }).catch((err) => console.error('[AuditLog] Bulk delete transaction log error:', err));
      }
    }

    res.json({
      success: true,
      message: `Deleted ${deleted.length || ids.length} transaction(s)`,
      count: deleted.length || ids.length,
    });
  } catch (err) {
    console.error('Bulk delete transactions error:', err);
    res.status(500).json({ error: err.message || 'Failed to bulk delete transactions' });
  }
});

router.delete('/', checkPermission('deleteTransactions'), async (req, res) => {
  try {
    const rawIds = Array.isArray(req.body.ids) ? req.body.ids : [];
    const ids = uniqueIds(rawIds);
    if (!ids.length) {
      return res.status(400).json({ error: 'No transaction IDs provided' });
    }

    const idColumn = resolveIdColumn('transactions');
    const existing = await fetchMany('transactions', {
      filters: [{ column: idColumn, operator: 'in', value: ids }],
    });

    if (Array.isArray(existing) && existing.length > 1) {
      existing.sort((a, b) => {
        const typeA = normalizeTransactionType(a.type);
        const typeB = normalizeTransactionType(b.type);
        const isReturnA = typeA.startsWith('RETURN') || typeA === 'SITE_TRANSFER' || typeA.includes('SCRAP');
        const isReturnB = typeB.startsWith('RETURN') || typeB === 'SITE_TRANSFER' || typeB.includes('SCRAP');

        if (isReturnA && !isReturnB) return -1;
        if (!isReturnA && isReturnB) return 1;

        const dateA = new Date(a.eventTimestamp || a.timestamp || a.createdAt || 0).getTime();
        const dateB = new Date(b.eventTimestamp || b.timestamp || b.createdAt || 0).getTime();
        return dateB - dateA;
      });
    }

    const sortedIds = (Array.isArray(existing) && existing.length > 0)
      ? existing.map((t) => t.id || t._id).filter(Boolean)
      : ids;

    const deleted = await deleteRows('transactions', sortedIds.length ? sortedIds : ids);
    const inventoryIds = uniqueIds(
      existing.map((t) => t.inventoryId || t.inventory_id || t.item || t.itemId).filter(Boolean)
    );

    if (inventoryIds.length > 0) {
      recalculateInventoryStocks(inventoryIds).catch((err) =>
        console.error('Stock recalc error on bulk delete:', err)
      );
    }

    if (Array.isArray(existing) && existing.length > 0) {
      for (const tx of existing) {
        logAudit({
          action: 'DELETE_TRANSACTION',
          entityType: 'transaction',
          entityId: tx.id || tx._id || tx.transactionId,
          user: req.user,
          req,
          previousValue: tx,
          newValue: null,
          details: `Deleted transaction: ${tx.transactionId || tx.id} (${tx.type}, Qty: ${tx.quantity})`,
        }).catch((err) => console.error('[AuditLog] Bulk delete transaction log error:', err));
      }
    }

    res.json({
      success: true,
      message: `Deleted ${deleted.length || ids.length} transaction(s)`,
      count: deleted.length || ids.length,
    });
  } catch (err) {
    console.error('Bulk delete transactions error:', err);
    res.status(500).json({ error: err.message || 'Failed to bulk delete transactions' });
  }
});

router.delete('/:id', checkPermission('deleteTransactions'), async (req, res) => {
  try {
    const existingRows = await resolveDeliveryRows(req.params.id);
    if (existingRows.length > 0 && normalizeTransactionType(existingRows[0].type) === 'DELIVERY') {
      const affectedItemIds = uniqueIds(existingRows.map((row) => row.inventoryId));
      for (const row of existingRows) {
        await deleteRow('transactions', row.id || row._id);
      }
      recalculateInventoryStocks(affectedItemIds).catch((err) =>
        console.error('Background stock recalc error:', err),
      );
      const txnId = existingRows[0]?.transactionId || req.params.id;
      logAudit({
        action: 'DELETE_DELIVERY',
        entityType: 'delivery',
        entityId: txnId,
        user: req.user,
        req,
        previousValue: existingRows,
        newValue: null,
        details: `Deleted delivery ${txnId} (${existingRows.length} item rows)`,
      }).catch((err) => console.error('[AuditLog] Delete delivery log error:', err));
      return res.json({ message: 'Deleted' });
    }

    const transaction = await fetchTransactionByIdentifier(req.params.id);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

    const deleteBlockReason = await getDeleteBlockReason(transaction);
    if (deleteBlockReason) {
      return res.status(409).json({ error: deleteBlockReason });
    }

    await deleteRow('transactions', transaction.id || transaction._id || req.params.id);

    const inventoryId = transaction.inventoryId || transaction.inventory_id || transaction.item || transaction.itemId;
    if (inventoryId) {
      recalculateInventoryStocks([inventoryId]).catch((err) => console.error('Stock recalc error:', err));
    }

    logAudit({
      action: 'DELETE_TRANSACTION',
      entityType: 'transaction',
      entityId: transaction.id || transaction._id || transaction.transactionId || req.params.id,
      user: req.user,
      req,
      previousValue: transaction,
      newValue: null,
      details: `Deleted transaction: ${transaction.transactionId || transaction.id} (${transaction.type}, Qty: ${transaction.quantity})`,
    }).catch((err) => console.error('[AuditLog] Delete transaction log error:', err));

    res.json({ message: 'Transaction deleted' });
  } catch (err) {
    console.error('Delete transaction error:', err);
    const status = err.message === 'Item not found' ? 404 : 500;
    res.status(status).json({ error: status === 404 ? 'Item not found' : 'Internal server error' });
  }
});

module.exports = router;
