const { fetchMany, hasColumn, updateRow, uniqueIds } = require('./db');
const {
  isStockOutTransaction,
  normalizeTransactionType,
} = require('./transactionType');

function _toItemId(value) {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

function _normalizeSiteLabel(site) {
  const siteCode = String(site?.siteCode || '').trim().toUpperCase();
  const siteName = String(site?.siteName || site?.name || '').trim().toUpperCase();
  return siteCode === 'WAREHOUSE' || siteName === 'WAREHOUSE';
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

function _getTransactionSourceSiteId(transaction, normalizedType) {
  if (normalizedType === 'SITE TRANSFER') {
    return _normalizeSiteId(transaction?.fromSiteId || transaction?.from_site_id);
  }

  if (normalizedType === 'RETURN') {
    return (
      _normalizeSiteId(transaction?.fromSiteId || transaction?.from_site_id) ||
      _normalizeSiteId(transaction?.siteId || transaction?.site_id)
    );
  }

  return null;
}

function _getTransactionDestinationSiteId(transaction, normalizedType) {
  if (normalizedType === 'SITE TRANSFER') {
    return _normalizeSiteId(transaction?.toSiteId || transaction?.to_site_id);
  }

  if (normalizedType === 'ISSUE') {
    return (
      _normalizeSiteId(transaction?.toSiteId || transaction?.to_site_id) ||
      _normalizeSiteId(transaction?.siteId || transaction?.site_id)
    );
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
      item.currentStock !== undefined && item.currentStock !== null
        ? item.currentStock
        : item.initialStock || item.initial_stock || 0
    );

    if (stockAmount > 0) {
      let initialSiteId = _normalizeSiteId(item.locationSiteId || item.location_site_id);

      if (!initialSiteId && item.location) {
        const locName = String(item.location).trim().toLowerCase();
        if (siteNameToIdMap.has(locName)) {
          initialSiteId = siteNameToIdMap.get(locName);
        } else if (locName !== 'warehouse') {
          initialSiteId = `loc_${String(item.location).trim()}`;
          if (!siteMap.has(initialSiteId)) {
            siteMap.set(initialSiteId, {
              id: initialSiteId,
              siteName: String(item.location).trim(),
            });
          }
        }
      }

      if (!initialSiteId) {
        initialSiteId = warehouseSiteId;
      }

      balanceMap.set(initialSiteId, stockAmount);
    }

    balancesByItem.set(itemId, balanceMap);
  }

  const sortedTransactions = [...(transactions || [])].sort(_compareTransactions);

  for (const transaction of sortedTransactions) {
    const itemId = _toItemId(transaction.inventoryId || transaction.inventory_id);
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
      case 'NEW':
      case 'DELIVERY':
        _addSiteQuantity(balanceMap, warehouseSiteId, quantity);
        break;
      case 'ISSUE':
        _addSiteQuantity(balanceMap, warehouseSiteId, -quantity);
        _addSiteQuantity(
          balanceMap,
          _getTransactionDestinationSiteId(transaction, normalizedType),
          quantity,
        );
        break;
      case 'RETURN':
        _addSiteQuantity(
          balanceMap,
          _getTransactionSourceSiteId(transaction, normalizedType),
          -quantity,
        );
        _addSiteQuantity(balanceMap, warehouseSiteId, quantity);
        break;
      case 'SITE TRANSFER':
        _addSiteQuantity(
          balanceMap,
          _getTransactionSourceSiteId(transaction, normalizedType),
          -quantity,
        );
        _addSiteQuantity(
          balanceMap,
          _getTransactionDestinationSiteId(transaction, normalizedType),
          quantity,
        );
        break;
      default:
        if (isStockOutTransaction(normalizedType)) {
          _addSiteQuantity(balanceMap, warehouseSiteId, -quantity);
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
        const siteName =
          site?.siteName ||
          site?.name ||
          site?.site_name ||
          (siteId === warehouseSiteId || siteId === 'warehouse' ? 'Warehouse' : 'Unknown');
        return {
          siteId,
          siteName,
          quantity: Number(quantity),
          isWarehouse: Boolean(
            siteId === warehouseSiteId ||
            siteId === 'warehouse' ||
            siteName.toLowerCase() === 'warehouse'
          ),
        };
      })
      .sort((a, b) => {
        if (a.isWarehouse != b.isWarehouse) {
          return a.isWarehouse ? -1 : 1;
        }
        return a.siteName.toLowerCase().localeCompare(b.siteName.toLowerCase());
      });

    let summary = 'No stock';
    let locationSiteId = null;

    if (positiveEntries.length === 1) {
      summary = positiveEntries[0].siteName;
      locationSiteId = positiveEntries[0].siteId;
    } else if (positiveEntries.length > 1) {
      summary = `${positiveEntries.length} locations`;
    } else if (warehouseSiteId) {
      summary = 'Warehouse';
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
  const newByItem = new Map();
  const deliveredByItem = new Map();

  for (const transaction of transactions) {
    const itemId = _toItemId(transaction.inventoryId);
    if (!itemId) {
      continue;
    }

    const quantity = Number(transaction.quantity || 0);
    const normalizedType = normalizeTransactionType(transaction.type);
    if (normalizedType === 'DELIVERY') {
      deliveredByItem.set(itemId, (deliveredByItem.get(itemId) || 0) + quantity);
    } else if (isStockOutTransaction(normalizedType)) {
      issuedByItem.set(itemId, (issuedByItem.get(itemId) || 0) + quantity);
    } else if (normalizedType === 'RETURN') {
      returnedByItem.set(itemId, (returnedByItem.get(itemId) || 0) + quantity);
    } else if (normalizedType === 'NEW') {
      newByItem.set(itemId, (newByItem.get(itemId) || 0) + quantity);
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
      : Number(item.initialStock || 0);

    result.set(
      itemId,
      initialStock +
        (deliveredByItem.get(itemId) || 0) -
        (issuedByItem.get(itemId) || 0) +
        (returnedByItem.get(itemId) || 0) +
        (newByItem.get(itemId) || 0),
    );
  }

  return result;
}

async function _resolveInventoryLocationUpdates(items, transactions) {
  const [supportsLocation, supportsLocationSiteId, sites] = await Promise.all([
    hasColumn('inventory', 'location'),
    hasColumn('inventory', 'locationSiteId'),
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
    fetchMany('inventory', {
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
      ? fetchMany('inventory', {
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
        return updateRow('inventory', itemId, { currentStock, ...locationUpdate });
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
    fetchMany('inventory'),
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
        return updateRow('inventory', itemId, { currentStock, ...locationUpdate });
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
