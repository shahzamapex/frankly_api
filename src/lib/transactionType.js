const VALID_TRANSACTION_TYPES = [
  'DELIVERY',
  'ISSUE',
  'RETURN',
  'NEW',
  'EMPLOYEE ISSUE',
  'SITE TRANSFER',
  'SCRAPPED',
  'REPAIR',
  'GOING TO REPAIR',
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
    case 'REPAIR':
    case 'REPAIRS':
    case 'GOINGTOREPAIR':
    case 'OUTFORREPAIR':
    case 'FORREPAIR':
      return 'REPAIR';
    default:
      return upper.replace(/\s+/g, ' ');
  }
}

function isStockOutTransaction(type) {
  const normalizedType = normalizeTransactionType(type);
  return normalizedType === 'ISSUE' ||
    normalizedType === 'EMPLOYEE ISSUE' ||
    normalizedType === 'SCRAPPED' ||
    normalizedType === 'CONSUMED' ||
    normalizedType === 'REPAIR' ||
    normalizedType === 'GOING TO REPAIR';
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
