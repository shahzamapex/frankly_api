const { fetchMany, hasColumn, updateRow, uniqueIds } = require('./db');
const {
  isStockOutTransaction,
  normalizeTransactionType,
} = require('./transactionType');

function _toItemId(value) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'object') {
    return String(value.id || value._id || value.itemId || value.item_id || '');
  }
  return String(value);
}

function _normalizeSiteLabel(site) {
  const siteCode = String(site?.siteCode || '').trim().toUpperCase();
  const siteName = String(site?.siteName || site?.name || '').trim().toUpperCase();
  return siteCode === 'WH' || siteName === 'WAREHOUSE';
}

function _transactionTimestampValue(transaction) {
  const value =
    transaction?.deliveryDate ||
    transaction?.eventTimestamp ||
    transaction?.timestamp ||
    null;
  const parsed = value ? new Date(value).getTime() : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function _transactionIdentityValue(transaction) {
  return String(
    transaction?.transactionId ||
    transaction?.deliveryId ||
    transaction?.id ||
    transaction?._id ||
    '',
  );
}

function _normalizeSiteId(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function _compareTransactions(a, b) {
  const aTimestamp = _transactionTimestampValue(a);
  const bTimestamp = _transactionTimestampValue(b);
  if (aTimestamp !== bTimestamp) {
    return aTimestamp - bTimestamp;
  }

  return _transactionIdentityValue(a).localeCompare(_transactionIdentityValue(b));
}

function _addSiteQuantity(balanceMap, siteId, quantity) {
  const normalizedSiteId = _normalizeSiteId(siteId);
  if (!normalizedSiteId || !Number.isFinite(quantity) || quantity === 0) {
    return;
  }

  balanceMap.set(normalizedSiteId, (balanceMap.get(normalizedSiteId) || 0) + quantity);
}

function _resolveTransactionSiteId(siteValue, siteMap, siteNameToIdMap) {
  const normalized = _normalizeSiteId(siteValue);
  if (!normalized) return null;

  if (siteMap.has(normalized)) {
    return normalized;
  }

  const lowerName = normalized.toLowerCase();
  if (siteNameToIdMap.has(lowerName)) {
    return siteNameToIdMap.get(lowerName);
  }

  const dynamicId = `site_${normalized}`;
  if (!siteMap.has(dynamicId)) {
    siteMap.set(dynamicId, { id: dynamicId, siteName: normalized });
  }
  return dynamicId;
}

function _extractSiteValue(value) {
  if (!value) return null;
  if (typeof value === 'object') {
    return value.id || value._id || value.siteId || value.site_id || value.siteName || value.site_name || value.name || null;
  }
  return value;
}

function _getTransactionSourceSiteId(transaction, normalizedType, siteMap, siteNameToIdMap, warehouseSiteId) {
  if (
    normalizedType === 'SITE TRANSFER' ||
    normalizedType.startsWith('RETURN')
  ) {
    const rawSite = transaction?.fromSiteId || transaction?.siteId;
    const resolvedSite = _resolveTransactionSiteId(rawSite, siteMap, siteNameToIdMap);
    if (resolvedSite) return resolvedSite;

    const empId = transaction?.employeeId || transaction?.employee_id || (typeof transaction?.employee === 'object' ? (transaction.employee.id || transaction.employee._id) : transaction?.employee);
    const empName = String(transaction?.employeeName || transaction?.employee_name || (typeof transaction?.employee === 'object' ? (transaction.employee.fullName || transaction.employee.name) : '') || '').trim();
    if (empId || empName) {
      const key = `emp_${empId || empName}`;
      if (!siteMap.has(key)) {
        siteMap.set(key, { id: key, siteName: empName || 'Employee', siteCode: empName || 'Employee' });
      }
      return key;
    }

    return warehouseSiteId;
  }

  return warehouseSiteId;
}

function _getTransactionDestinationSiteId(transaction, normalizedType, siteMap, siteNameToIdMap, warehouseSiteId) {
  if (
    normalizedType === 'SITE TRANSFER' ||
    normalizedType.startsWith('ISSUE')
  ) {
    const rawSite = transaction?.toSiteId || transaction?.siteId;
    const resolvedSite = _resolveTransactionSiteId(rawSite, siteMap, siteNameToIdMap);
    if (resolvedSite) return resolvedSite;

    const empId = transaction?.employeeId || transaction?.employee_id || (typeof transaction?.employee === 'object' ? (transaction.employee.id || transaction.employee._id) : transaction?.employee);
    const empName = String(transaction?.employeeName || transaction?.employee_name || (typeof transaction?.employee === 'object' ? (transaction.employee.fullName || transaction.employee.name) : '') || '').trim();
    if (empId || empName) {
      const key = `emp_${empId || empName}`;
      if (!siteMap.has(key)) {
        siteMap.set(key, { id: key, siteName: empName || 'Employee', siteCode: empName || 'Employee' });
      }
      return key;
    }
  }

  if (normalizedType.startsWith('RETURN') || normalizedType === 'DELIVERY') {
    const rawSite = transaction?.toSiteId;
    return _resolveTransactionSiteId(rawSite, siteMap, siteNameToIdMap) || warehouseSiteId;
  }

  return null;
}

function _buildInventoryLocationState(items, transactions, sites) {
  const siteMap = new Map();
  const siteNameToIdMap = new Map();

  for (const site of sites || []) {
    const siteId = String(site.id || site._id || '');
    if (siteId) {
      siteMap.set(siteId, site);
      const name = String(site.siteName || site.name || site.site_name || '').trim().toLowerCase();
      if (name) {
        siteNameToIdMap.set(name, siteId);
      }
    }
  }

  const warehouseSite = (sites || []).find(_normalizeSiteLabel) || null;
  const warehouseSiteId = warehouseSite
    ? String(warehouseSite.id || warehouseSite._id || '')
    : 'warehouse';

  if (!siteMap.has(warehouseSiteId)) {
    siteMap.set(warehouseSiteId, { id: warehouseSiteId, siteName: 'Warehouse' });
  }

  const balancesByItem = new Map();

  for (const item of items || []) {
    const itemId = _toItemId(item.id || item._id);
    if (!itemId) {
      continue;
    }

    const balanceMap = new Map();
    const stockAmount = Number(
      item.initialStock !== undefined && item.initialStock !== null && Number(item.initialStock) > 0
        ? item.initialStock
        : (item.initial_stock || item.currentStock || item.current_stock || 0)
    );

    if (stockAmount > 0) {
      balanceMap.set(warehouseSiteId, stockAmount);
    }

    balancesByItem.set(itemId, balanceMap);
  }

  const sortedTransactions = [...(transactions || [])].sort(_compareTransactions);

  for (const transaction of sortedTransactions) {
    const itemId = _toItemId(
      transaction.inventoryId ||
      transaction.inventory_id ||
      transaction.item ||
      transaction.item_id ||
      transaction.inventory
    );
    if (!itemId || !balancesByItem.has(itemId)) {
      continue;
    }

    const quantity = Number(transaction.quantity || 0);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      continue;
    }

    const normalizedType = normalizeTransactionType(transaction.type);
    const balanceMap = balancesByItem.get(itemId);

    if (!balanceMap) {
      continue;
    }

    switch (normalizedType) {
      case 'RETURN_NEW':
      case 'DELIVERY':
        _addSiteQuantity(balanceMap, warehouseSiteId, quantity);
        break;
      case 'ISSUE_SITE':
      case 'ISSUE_EMPLOYEE':
      case 'ISSUE_REPAIR':
      case 'ISSUE_SCRAP':
        _addSiteQuantity(balanceMap, warehouseSiteId, -quantity);
        _addSiteQuantity(
          balanceMap,
          _getTransactionDestinationSiteId(transaction, normalizedType, siteMap, siteNameToIdMap, warehouseSiteId),
          quantity,
        );
        break;
      case 'RETURN_SITE':
      case 'RETURN_EMPLOYEE':
      case 'RETURN_REPAIR':
        _addSiteQuantity(
          balanceMap,
          _getTransactionSourceSiteId(transaction, normalizedType, siteMap, siteNameToIdMap, warehouseSiteId),
          -quantity,
        );
        _addSiteQuantity(balanceMap, warehouseSiteId, quantity);
        break;
      case 'SITE TRANSFER':
        _addSiteQuantity(
          balanceMap,
          _getTransactionSourceSiteId(transaction, normalizedType, siteMap, siteNameToIdMap, warehouseSiteId),
          -quantity,
        );
        _addSiteQuantity(
          balanceMap,
          _getTransactionDestinationSiteId(transaction, normalizedType, siteMap, siteNameToIdMap, warehouseSiteId),
          quantity,
        );
        break;
      default:
        if (isStockOutTransaction(normalizedType)) {
          _addSiteQuantity(balanceMap, warehouseSiteId, -quantity);
        } else if (isStockInTransaction(normalizedType)) {
          _addSiteQuantity(balanceMap, warehouseSiteId, quantity);
        }
        break;
    }
  }

  const result = new Map();

  for (const item of items || []) {
    const itemId = _toItemId(item.id || item._id);
    if (!itemId) {
      continue;
    }

    const balanceMap = balancesByItem.get(itemId) || new Map();
    const positiveEntries = Array.from(balanceMap.entries())
      .filter(([, quantity]) => Number(quantity) > 0)
      .map(([siteId, quantity]) => {
        const site = siteMap.get(siteId);
        const rawCode =
          site?.siteCode ||
          site?.site_code ||
          site?.code;
        const rawName =
          site?.siteName ||
          site?.name ||
          site?.site_name ||
          (siteId === warehouseSiteId || siteId === 'warehouse' ? 'Warehouse' : 'Unknown');

        const siteCode = (rawCode && String(rawCode).trim().length > 0)
          ? String(rawCode).trim()
          : String(rawName).trim();

        return {
          siteId,
          siteName: String(rawName).trim(),
          siteCode,
          quantity: Number(quantity),
          isWarehouse: Boolean(
            siteId === warehouseSiteId ||
            siteId === 'warehouse' ||
            String(rawName).toLowerCase() === 'warehouse' ||
            siteCode.toLowerCase() === 'wh'
          ),
        };
      })
      .sort((a, b) => {
        if (a.isWarehouse != b.isWarehouse) {
          return a.isWarehouse ? -1 : 1;
        }
        return a.siteCode.toLowerCase().localeCompare(b.siteCode.toLowerCase());
      });

    let summary = 'Warehouse';
    let locationSiteId = warehouseSiteId !== 'warehouse' ? warehouseSiteId : null;

    if (positiveEntries.length === 1) {
      summary = positiveEntries[0].siteCode;
      locationSiteId = positiveEntries[0].siteId;
    } else if (positiveEntries.length > 1) {
      summary = positiveEntries.map((e) => `${e.siteCode} (${e.quantity})`).join(', ');
    } else if (warehouseSiteId) {
      const whSite = siteMap.get(warehouseSiteId);
      summary = whSite?.siteCode || whSite?.site_code || whSite?.code || 'Warehouse';
    }

    result.set(itemId, {
      location: summary,
      locationSiteId,
      locationBreakdown: positiveEntries,
    });
  }

  return result;
}

function _buildStockMap(items, transactions, initialStockOverrides = new Map()) {
  const issuedByItem = new Map();
  const returnedByItem = new Map();
  const deliveredByItem = new Map();

  for (const transaction of transactions) {
    const itemId = _toItemId(
      transaction.inventoryId ||
      transaction.inventory_id ||
      transaction.item ||
      transaction.itemId ||
      transaction.item_id
    );
    if (!itemId) {
      continue;
    }

    const quantity = Number(transaction.quantity || 0);
    const normalizedType = normalizeTransactionType(transaction.type);
    if (normalizedType === 'DELIVERY') {
      deliveredByItem.set(itemId, (deliveredByItem.get(itemId) || 0) + quantity);
    } else if (isStockOutTransaction(normalizedType)) {
      issuedByItem.set(itemId, (issuedByItem.get(itemId) || 0) + quantity);
    } else if (isStockInTransaction(normalizedType)) {
      returnedByItem.set(itemId, (returnedByItem.get(itemId) || 0) + quantity);
    }
  }

  const result = new Map();
  for (const item of items) {
    const itemId = _toItemId(item.id || item._id);
    if (!itemId) {
      continue;
    }

    const initialStock = initialStockOverrides.has(itemId)
      ? Number(initialStockOverrides.get(itemId) || 0)
      : Number(item.initialStock !== undefined && item.initialStock !== null ? item.initialStock : (item.initial_stock || 0));

    result.set(
      itemId,
      initialStock +
      (deliveredByItem.get(itemId) || 0) -
      (issuedByItem.get(itemId) || 0) +
      (returnedByItem.get(itemId) || 0),
    );
  }

  return result;
}

async function _resolveInventoryLocationUpdates(items, transactions) {
  const [supportsLocation, supportsLocationSiteId, sites] = await Promise.all([
    hasColumn('inventories', 'location'),
    hasColumn('inventories', 'locationSiteId'),
    fetchMany('sites'),
  ]);

  if (!supportsLocation && !supportsLocationSiteId) {
    return new Map();
  }

  const locationState = _buildInventoryLocationState(items, transactions, sites);

  const updates = new Map();
  for (const item of items) {
    const itemId = _toItemId(item.id || item._id);
    if (!itemId) {
      continue;
    }

    const state = locationState.get(itemId);
    const nextLocation = state?.location || item.location || 'Warehouse';

    updates.set(itemId, {
      ...(supportsLocation ? { location: nextLocation } : {}),
      ...(supportsLocationSiteId
        ? {
          locationSiteId: state?.locationSiteId || null,
        }
        : {}),
    });
  }

  return updates;
}

async function calculateInventoryStocks(itemIds, initialStockOverrides = new Map()) {
  const uniqueItemIds = uniqueIds(itemIds).map((value) => String(value));
  if (!uniqueItemIds.length) {
    return new Map();
  }

  const [items, transactions] = await Promise.all([
    fetchMany('inventories', {
      filters: [{ column: 'id', operator: 'in', value: uniqueItemIds }],
    }),
    fetchMany('transactions', {
      filters: [{ column: 'inventoryId', operator: 'in', value: uniqueItemIds }],
    }),
  ]);

  return _buildStockMap(items, transactions, initialStockOverrides);
}

async function recalculateInventoryStocks(itemIds, initialStockOverrides = new Map()) {
  const uniqueItemIds = uniqueIds(itemIds).map((value) => String(value));
  const [items, transactions] = await Promise.all([
    uniqueItemIds.length
      ? fetchMany('inventories', {
        filters: [{ column: 'id', operator: 'in', value: uniqueItemIds }],
      })
      : [],
    uniqueItemIds.length
      ? fetchMany('transactions', {
        filters: [{ column: 'inventoryId', operator: 'in', value: uniqueItemIds }],
      })
      : [],
  ]);
  const stockMap = _buildStockMap(items, transactions, initialStockOverrides);
  const locationUpdates = await _resolveInventoryLocationUpdates(items, transactions);
  const entries = Array.from(stockMap.entries());

  for (let index = 0; index < entries.length; index += 25) {
    const chunk = entries.slice(index, index + 25);
    await Promise.all(
      chunk.map(([itemId, currentStock]) => {
        const locationUpdate = locationUpdates.get(itemId) || {};
        return updateRow('inventories', itemId, { currentStock, ...locationUpdate });
      }),
    );
  }

  return stockMap;
}

async function recalculateInventoryStock(itemId, initialStockOverride) {
  const normalizedId = _toItemId(itemId);
  if (!normalizedId) {
    return 0;
  }

  const stockMap = await recalculateInventoryStocks(
    [normalizedId],
    initialStockOverride === undefined
      ? new Map()
      : new Map([[normalizedId, Number(initialStockOverride || 0)]]),
  );
  return stockMap.get(normalizedId) || 0;
}

async function recalculateAllInventoryStock() {
  const [items, transactions] = await Promise.all([
    fetchMany('inventories'),
    fetchMany('transactions'),
  ]);

  const stockMap = _buildStockMap(items, transactions);
  const locationUpdates = await _resolveInventoryLocationUpdates(items, transactions);
  const entries = Array.from(stockMap.entries());

  for (let index = 0; index < entries.length; index += 25) {
    const chunk = entries.slice(index, index + 25);
    await Promise.all(
      chunk.map(([itemId, currentStock]) => {
        const locationUpdate = locationUpdates.get(itemId) || {};
        return updateRow('inventories', itemId, { currentStock, ...locationUpdate });
      }),
    );
  }

  return {
    total: items.length,
    updated: entries.length,
  };
}

module.exports = {
  _buildInventoryLocationState,
  calculateInventoryStocks,
  recalculateInventoryStock,
  recalculateInventoryStocks,
  recalculateAllInventoryStock,
};
