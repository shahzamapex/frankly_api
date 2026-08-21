const express = require('express');
const { ID_COLUMN, fetchById, fetchOne, fetchMany, deleteRow, deleteRows, hasColumn, indexById, insertRow, insertRows, uniqueIds } = require('../lib/db');
const checkPermission = require('../middlewares/checkPermission');
const { recalculateInventoryStocks } = require('../lib/stock');
const { VALID_TRANSACTION_TYPES, normalizeTransactionType } = require('../lib/transactionType');

const router = express.Router();

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

function buildTransactionWritePayload(body, warehouseSiteId, scrappedSiteId) {
  const normalizedType = normalizeTransactionType(body.type);
  const fromSiteIdInput = body.fromSiteId || body.fromSite || null;
  const toSiteIdInput = body.toSiteId || body.toSite || null;
  const legacySite = body.site || null;
  let fromSiteId = fromSiteIdInput;
  let toSiteId = toSiteIdInput;

  switch (normalizedType) {
    case 'ISSUE':
    case 'ISSUE_SITE':
      fromSiteId = fromSiteId || warehouseSiteId;
      toSiteId = toSiteId || legacySite;
      break;
    case 'RETURN':
    case 'RETURN_SITE':
      fromSiteId = fromSiteId || legacySite;
      toSiteId = toSiteId || warehouseSiteId;
      break;
    case 'EMPLOYEE ISSUE':
    case 'ISSUE_EMPLOYEE':
      fromSiteId = fromSiteId || warehouseSiteId;
      break;
    case 'RETURN_EMPLOYEE':
      toSiteId = toSiteId || warehouseSiteId;
      break;
    case 'CONSUMED':
      fromSiteId = fromSiteId || warehouseSiteId;
      toSiteId = toSiteId || legacySite;
      break;
    case 'SCRAPPED':
    case 'ISSUE_SCRAP':
      fromSiteId = fromSiteId || legacySite || warehouseSiteId;
      toSiteId = toSiteId || scrappedSiteId;
      break;
    case 'REPAIR':
    case 'GOING TO REPAIR':
    case 'ISSUE_REPAIR':
      fromSiteId = fromSiteId || legacySite || warehouseSiteId;
      toSiteId = toSiteId || body.toSiteId || body.workshopId || body.vendorId || null;
      break;
    case 'RETURN_REPAIR':
      fromSiteId = fromSiteId || body.fromSiteId || body.workshopId || body.vendorId || legacySite;
      toSiteId = toSiteId || warehouseSiteId;
      break;
    case 'SITE TRANSFER':
      fromSiteId = fromSiteId || legacySite;
      break;
    case 'NEW':
    case 'RETURN_NEW':
    case 'DELIVERY':
      fromSiteId = fromSiteId || body.fromSiteId || body.fromSite || body.siteId || body.site || body.vendorId || body.seller || null;
      toSiteId = toSiteId || body.toSiteId || body.toSite || warehouseSiteId;
      break;
    default:
      break;
  }

  const notesValue = body.notes || body.returnDetails?.notes || null;
  const proofUrl = body.proofImage || body.proof_image || null;
  const sigUrl = body.signatureImage || body.signature_image || null;

  return {
    type: normalizedType,
    inventoryId: body.inventoryId || body.item,
    quantity: Number(body.quantity),
    fromSiteId: fromSiteId || null,
    toSiteId: toSiteId || null,
    siteId: toSiteId || fromSiteId || null,
    employeeId: body.employeeId || body.employee || null,
    returnCondition: body.returnCondition || body.returnDetails?.condition || null,
    notes: notesValue,
    proofImage: proofUrl || null,
    signature_image: sigUrl || null,
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
      employee,
      fromSite,
      toSite,
      site: compatibilitySite,
      item: transaction.inventoryId ? (itemMap.get(String(transaction.inventoryId)) || transaction.inventoryId) : transaction.inventoryId,
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

async function generateTransactionId(timestamp) {
  const now = timestamp ? new Date(timestamp) : getDubaiTime();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const prefix = `TXN-${dd}${mm}${yyyy}-`;

  const latest = await fetchMany('transactions', {
    filters: [{ column: 'transactionId', operator: 'like', value: `${prefix}%` }],
    orderBy: 'transactionId',
    ascending: false,
    limit: 1,
  });

  let nextNum = 1;
  if (latest[0]?.transactionId) {
    const match = latest[0].transactionId.match(/-(\d+)$/);
    if (match) {
      nextNum = Number.parseInt(match[1], 10) + 1;
    }
  }

  return {
    transactionId: `${prefix}${String(nextNum).padStart(4, '0')}`,
    timestamp: now.toISOString(),
  };
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
    return 'Site transfer transactions cannot be deleted individually.';
  }

  const inventoryId = transaction?.inventoryId || null;
  if (!inventoryId) {
    return null;
  }

  const relatedTransactions = await fetchMany('transactions', {
    filters: [{ column: 'inventoryId', operator: 'eq', value: inventoryId }],
    orderBy: 'eventTimestamp',
    ascending: false,
    limit: 10,
  });
  const currentId = String(transaction.id || transaction._id || '');

  const hasLaterMovement = relatedTransactions.some((entry) => {
    const entryId = String(entry.id || entry._id || '');
    return entryId !== currentId && isLaterTransaction(entry, transaction);
  });

  if (hasLaterMovement) {
    return 'Cannot delete this transaction because newer movement exists for this item. Delete the latest related transaction first, or add a correcting transaction instead.';
  }

  return null;
}

router.get('/', checkPermission('viewTransactions'), async (req, res) => {
  try {
    const filters = [];
    const includeDelivery = String(req.query.includeDelivery || '')
      .trim()
      .toLowerCase() === 'true';
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
      if (!includeDelivery && normalizeTransactionType(transaction.type) === 'DELIVERY') {
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
    const transaction = await fetchTransactionByIdentifier(req.params.id);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });
    res.json(await populateTransaction(transaction));
  } catch (err) {
    console.error('Get transaction error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', checkPermission('addTransactions'), async (req, res) => {
  try {
    const { item, timestamp } = req.body;

    const validationError = validateTransactionInput(req.body);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const [existingItem, { transactionId, timestamp: createdTimestamp }, warehouseSiteId, scrappedSiteId] = await Promise.all([
      fetchById('inventories', item),
      generateTransactionId(timestamp),
      req.body?.warehouseSite ? Promise.resolve(req.body.warehouseSite) : resolveWarehouseSiteId(),
      resolveScrappedSiteId(),
    ]);

    if (!existingItem) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const writePayload = buildTransactionWritePayload(req.body, warehouseSiteId, scrappedSiteId);
    const transaction = await insertRow('transactions', {
      transactionId,
      eventTimestamp: createdTimestamp,
      ...writePayload,
    });

    recalculateInventoryStocks([item]).catch((err) => console.error('Background stock recalc error:', err));

    const populated = await populateTransaction(transaction);

    res.status(201).json(populated);
  } catch (err) {
    console.error('Create transaction error:', err);
    const status = err.message === 'Item not found' ? 404 : 500;
    res.status(status).json({ error: status === 404 ? 'Item not found' : 'Internal server error' });
  }
});

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
    const now = new Date().toISOString();
    const deliveryTimestamp = normalized[0]?.body?.timestamp;
    const { transactionId: firstTransactionId } = await generateTransactionId(deliveryTimestamp);
    const prefixMatch = firstTransactionId.match(/^(.*-)(\d+)$/);
    const prefix = prefixMatch ? prefixMatch[1] : firstTransactionId;
    const startSequence = prefixMatch ? Number.parseInt(prefixMatch[2], 10) : 1;

    const rowsToInsert = normalized.map((entry, index) => {
      const writePayload = buildTransactionWritePayload(
        entry.body,
        entry.body.warehouseSite || warehouseSiteId,
        scrappedSiteId,
      );
      return {
        transactionId: `${prefix}${String(startSequence + index).padStart(4, '0')}`,
        eventTimestamp: entry.body.timestamp || now,
        ...writePayload,
      };
    });

    const createdTransactions = await insertRows('transactions', rowsToInsert);

    recalculateInventoryStocks(itemIds).catch((err) => console.error('Background stock recalc error:', err));

    res.status(201).json(await populateTransactions(createdTransactions));
  } catch (err) {
    console.error('Create bulk transactions error:', err);
    const status = err.message === 'Item not found' ? 404 : 500;
    res.status(status).json({ error: status === 404 ? 'Item not found' : 'Internal server error' });
  }
});

router.put('/:id', checkPermission('editTransactions'), async (req, res) => {
  return res.status(403).json({ error: 'Transaction editing is disabled. Transactions cannot be edited.' });
});

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

    const deleted = await deleteRows('transactions', ids);
    const inventoryIds = uniqueIds(
      existing.map((t) => t.inventoryId || t.inventory_id || t.item || t.itemId).filter(Boolean)
    );

    if (inventoryIds.length > 0) {
      await recalculateInventoryStocks(inventoryIds).catch((err) =>
        console.error('Stock recalc error on bulk delete:', err)
      );
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

    const deleted = await deleteRows('transactions', ids);
    const inventoryIds = uniqueIds(
      existing.map((t) => t.inventoryId || t.inventory_id || t.item || t.itemId).filter(Boolean)
    );

    if (inventoryIds.length > 0) {
      await recalculateInventoryStocks(inventoryIds).catch((err) =>
        console.error('Stock recalc error on bulk delete:', err)
      );
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
    const transaction = await fetchTransactionByIdentifier(req.params.id);
    if (!transaction) return res.status(404).json({ error: 'Transaction not found' });

    const deleteBlockReason = await getDeleteBlockReason(transaction);
    if (deleteBlockReason) {
      return res.status(409).json({ error: deleteBlockReason });
    }

    await deleteRow('transactions', transaction.id || transaction._id || req.params.id);

    const inventoryId = transaction.inventoryId || transaction.inventory_id || transaction.item || transaction.itemId;
    if (inventoryId) {
      await recalculateInventoryStocks([inventoryId]).catch((err) => console.error('Stock recalc error:', err));
    }

    res.json({ message: 'Transaction deleted' });
  } catch (err) {
    console.error('Delete transaction error:', err);
    const status = err.message === 'Item not found' ? 404 : 500;
    res.status(status).json({ error: status === 404 ? 'Item not found' : 'Internal server error' });
  }
});

module.exports = router;
