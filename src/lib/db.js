const { getSupabaseAdmin } = require('./supabase');

const CONFIGURED_ID_COLUMN = process.env.SUPABASE_ID_COLUMN;
const ID_COLUMN = CONFIGURED_ID_COLUMN || 'id';
const USE_SNAKE_CASE = process.env.SUPABASE_USE_SNAKE_CASE !== 'false';

const TABLE_MAP = {
  users: 'users',
  inventories: 'inventories',
  sites: 'sites',
  transactions: 'transactions',
  app_configs: 'app_configs',
  app_config_faqs: 'app_config_faqs',
  vendors: 'vendors',
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toCamelCase(key) {
  if (key === '_id') {
    return key;
  }
  return key.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}

function toSnakeCase(key) {
  if (key === '_id') {
    return key;
  }
  return key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

function deepTransformKeys(value, transformer) {
  if (Array.isArray(value)) {
    return value.map((item) => deepTransformKeys(item, transformer));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    result[transformer(key)] = deepTransformKeys(entry, transformer);
  }
  return result;
}

function deepSerialize(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepSerialize(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    result[key] = deepSerialize(entry);
  }
  return result;
}

function normalizeRow(row) {
  if (!row) {
    return row;
  }

  const normalized = deepTransformKeys(row, toCamelCase);
  const recordId = normalized._id ?? normalized.id ?? row._id ?? row.id;

  if (recordId !== undefined && recordId !== null) {
    normalized._id = String(recordId);
    normalized.id = String(recordId);
  }

  return normalized;
}

function preparePayload(payload) {
  const serialized = deepSerialize(payload);
  if (!USE_SNAKE_CASE) {
    return serialized;
  }
  return deepTransformKeys(serialized, toSnakeCase);
}

function applyTimestamps(payload, availableColumns = {}, { forInsert = false } = {}) {
  const now = new Date().toISOString();
  const nextPayload = { ...payload };
  const canWriteCreatedAt = availableColumns.createdAt !== false;
  const canWriteUpdatedAt = availableColumns.updatedAt !== false;

  if (forInsert && canWriteCreatedAt && nextPayload.createdAt === undefined) {
    nextPayload.createdAt = now;
  }

  if (canWriteUpdatedAt && nextPayload.updatedAt === undefined) {
    nextPayload.updatedAt = now;
  }

  return nextPayload;
}

function generateObjectId() {
  const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  let random = '';
  while (random.length < 16) {
    random += Math.floor(Math.random() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  }
  return `${timestamp}${random}`.slice(0, 24);
}

function isSimpleColumnName(column) {
  return typeof column === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(column);
}

function normalizeColumnName(column, idColumn = 'id') {
  if (!column || !isSimpleColumnName(column)) {
    return column;
  }

  if (column === 'id' || column === '_id' || column === 'row_id') {
    return idColumn;
  }

  return USE_SNAKE_CASE ? toSnakeCase(column) : column;
}

function withId(payload, idColumn = 'id') {
  const explicitId = payload[idColumn] ?? payload._id ?? payload.id;
  if (explicitId !== undefined && explicitId !== null) {
    const nextPayload = { ...payload, [idColumn]: explicitId };
    if (idColumn !== '_id') delete nextPayload._id;
    if (idColumn !== 'id') delete nextPayload.id;
    return nextPayload;
  }

  return payload;
}

function resolveTable(entity) {
  return TABLE_MAP[entity] || entity;
}

function resolveIdColumn() {
  return 'id';
}

function normalizeFilters(entity, filters = []) {
  if (!filters.length) {
    return filters;
  }

  const idColumn = resolveIdColumn(entity);
  return filters.map((filter) => {
    if (!filter || !filter.column || filter.operator === 'or') {
      return filter;
    }

    return { ...filter, column: normalizeColumnName(filter.column, idColumn) };
  });
}

const resolvedColumns = new Map();

async function hasColumn(entity, column) {
  if (!column || !isSimpleColumnName(column)) {
    return false;
  }

  const table = resolveTable(entity);
  const idColumn = resolveIdColumn(entity);
  const actualColumn = normalizeColumnName(column, idColumn);
  const cacheKey = `${table}:${actualColumn}`;

  if (resolvedColumns.has(cacheKey)) {
    return resolvedColumns.get(cacheKey);
  }

  const { error } = await getSupabaseAdmin().from(table).select(actualColumn).limit(1);
  const exists = !error;
  resolvedColumns.set(cacheKey, exists);
  return exists;
}

function applyFilters(query, filters = []) {
  let nextQuery = query;

  for (const filter of filters) {
    if (!filter || filter.value === undefined) {
      continue;
    }

    switch (filter.operator) {
      case 'eq':
        nextQuery = nextQuery.eq(filter.column, filter.value);
        break;
      case 'in':
        nextQuery = nextQuery.in(filter.column, filter.value);
        break;
      case 'is':
        nextQuery = nextQuery.is(filter.column, filter.value);
        break;
      case 'gte':
        nextQuery = nextQuery.gte(filter.column, filter.value);
        break;
      case 'lte':
        nextQuery = nextQuery.lte(filter.column, filter.value);
        break;
      case 'like':
        nextQuery = nextQuery.like(filter.column, filter.value);
        break;
      case 'ilike':
        nextQuery = nextQuery.ilike(filter.column, filter.value);
        break;
      case 'or':
        nextQuery = nextQuery.or(filter.value);
        break;
      default:
        throw new Error(`Unsupported filter operator: ${filter.operator}`);
    }
  }

  return nextQuery;
}

function extractMissingColumn(error) {
  if (!error || error.code !== 'PGRST204' || typeof error.message !== 'string') {
    return null;
  }

  const match = error.message.match(/Could not find the '([^']+)' column of '[^']+' in the schema cache/);
  return match ? match[1] : null;
}

async function executeWriteWithColumnFallback(record, operation) {
  const currentRecord = { ...record };
  let attempts = 0;

  while (attempts < 20) {
    const { data, error } = await operation(currentRecord);
    if (!error) {
      return data;
    }

    const missingColumn = extractMissingColumn(error);
    if (!missingColumn || !Object.prototype.hasOwnProperty.call(currentRecord, missingColumn)) {
      throw error;
    }

    delete currentRecord[missingColumn];
    attempts += 1;
  }

  throw new Error('Supabase write failed after removing unsupported columns');
}

async function fetchMany(entity, options = {}) {
  const {
    select = '*',
    filters = [],
    orderBy,
    ascending = true,
    limit,
  } = options;

  const table = resolveTable(entity);
  const idColumn = resolveIdColumn(entity);
  const normalizedFilters = normalizeFilters(entity, filters);

  const normalizedOrderBy = orderBy && await hasColumn(entity, orderBy)
    ? normalizeColumnName(orderBy, idColumn)
    : null;
  let query = getSupabaseAdmin().from(table).select(select);
  query = applyFilters(query, normalizedFilters);

  if (normalizedOrderBy) {
    query = query.order(normalizedOrderBy, { ascending });
  }

  if (limit) {
    query = query.limit(limit);
  }

  const { data, error } = await query;
  if (error) {
    throw error;
  }

  return (data || []).map(normalizeRow);
}

async function fetchOne(entity, options = {}) {
  const rows = await fetchMany(entity, { ...options, limit: 1 });
  return rows[0] || null;
}

async function fetchById(entity, id, options = {}) {
  const idColumn = resolveIdColumn(entity);
  return fetchOne(entity, {
    ...options,
    filters: [...(options.filters || []), { column: idColumn, operator: 'eq', value: id }],
  });
}

async function insertRow(entity, payload, options = {}) {
  const { select = '*', timestamps = true } = options;
  const table = resolveTable(entity);
  const idColumn = resolveIdColumn(entity);
  const availableColumns = {
    createdAt: await hasColumn(entity, 'createdAt'),
    updatedAt: await hasColumn(entity, 'updatedAt'),
  };
  const basePayload = timestamps ? applyTimestamps(payload, availableColumns, { forInsert: true }) : { ...payload };
  const record = preparePayload(withId(basePayload, idColumn));
  const data = await executeWriteWithColumnFallback(record, (currentRecord) => (
    getSupabaseAdmin()
      .from(table)
      .insert(currentRecord)
      .select(select)
      .single()
  ));
  return normalizeRow(data);
}

async function updateRow(entity, id, payload, options = {}) {
  const { select = '*', timestamps = true } = options;
  const table = resolveTable(entity);
  const idColumn = resolveIdColumn(entity);
  const availableColumns = {
    createdAt: await hasColumn(entity, 'createdAt'),
    updatedAt: await hasColumn(entity, 'updatedAt'),
  };
  const nextPayload = timestamps ? applyTimestamps(payload, availableColumns) : { ...payload };
  const record = preparePayload(nextPayload);
  const data = await executeWriteWithColumnFallback(record, (currentRecord) => (
    getSupabaseAdmin()
      .from(table)
      .update(currentRecord)
      .eq(idColumn, id)
      .select(select)
      .maybeSingle()
  ));
  return normalizeRow(data);
}

async function deleteRow(entity, id) {
  const table = resolveTable(entity);
  const idColumn = resolveIdColumn(entity);
  const { data, error } = await getSupabaseAdmin()
    .from(table)
    .delete()
    .eq(idColumn, id)
    .select('*')
    .maybeSingle();

  if (error) {
    throw error;
  }

  return normalizeRow(data);
}

async function countRows(entity, filters = []) {
  const table = resolveTable(entity);
  const normalizedFilters = normalizeFilters(entity, filters);
  let query = getSupabaseAdmin().from(table).select('*', { head: true, count: 'exact' });
  query = applyFilters(query, normalizedFilters);
  const { count, error } = await query;

  if (error) {
    throw error;
  }

  return count || 0;
}

function uniqueIds(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value)))];
}

function indexById(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row) {
      continue;
    }
    const rowId = row._id ?? row.id;
    if (rowId) {
      map.set(String(rowId), row);
    }
  }
  return map;
}

module.exports = {
  ID_COLUMN,
  countRows,
  deleteRow,
  fetchById,
  fetchMany,
  fetchOne,
  generateObjectId,
  indexById,
  insertRow,
  normalizeRow,
  preparePayload,
  hasColumn,
  resolveIdColumn,
  resolveTable,
  uniqueIds,
  updateRow,
};
