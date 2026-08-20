const VALID_TRANSACTION_TYPES = [
  'DELIVERY',
  'ISSUE',
  'RETURN',
  'NEW',
  'EMPLOYEE ISSUE',
  'SITE TRANSFER',
  'SCRAPPED',
];

function normalizeTransactionType(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const upper = raw.toUpperCase();
  const compact = upper.replace(/[^A-Z]/g, '');

  switch (compact) {
    case 'ISSUE':
      return 'ISSUE';
    case 'RETURN':
      return 'RETURN';
    case 'NEW':
      return 'NEW';
    case 'DELIVERY':
      return 'DELIVERY';
    case 'EMPLOYEEISSUE':
    case 'EMPLOYEE':
      return 'EMPLOYEE ISSUE';
    case 'SCRAP':
    case 'SCRAPPED':
    case 'DAMAGE':
    case 'DAMAGED':
      return 'SCRAPPED';
    case 'CONSUMABLE':
    case 'CONSUMED':
      return 'SCRAPPED';
    case 'SITETRANSFER':
      return 'SITE TRANSFER';
    default:
      return upper.replace(/\s+/g, ' ');
  }
}

function isStockOutTransaction(type) {
  const normalizedType = normalizeTransactionType(type);
  return normalizedType === 'ISSUE' ||
    normalizedType === 'EMPLOYEE ISSUE' ||
    normalizedType === 'SCRAPPED' ||
    normalizedType === 'CONSUMED';
}

function isStockInTransaction(type) {
  const normalizedType = normalizeTransactionType(type);
  return normalizedType === 'RETURN' ||
    normalizedType === 'NEW' ||
    normalizedType === 'DELIVERY';
}

module.exports = {
  VALID_TRANSACTION_TYPES,
  isStockInTransaction,
  isStockOutTransaction,
  normalizeTransactionType,
};
