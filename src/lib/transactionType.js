const VALID_TRANSACTION_TYPES = [
  'ISSUE_SITE',
  'ISSUE_EMPLOYEE',
  'ISSUE_REPAIR',
  'ISSUE_SCRAP',
  'RETURN_SITE',
  'RETURN_EMPLOYEE',
  'RETURN_REPAIR',
  'RETURN_NEW',
  'SITE TRANSFER',
  'DELIVERY',
];

function normalizeTransactionType(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  const upper = raw.toUpperCase().replace(/\s+/g, '_');
  switch (upper) {
    case 'ISSUE_SITE':
    case 'ISSUE':
      return 'ISSUE_SITE';
    case 'ISSUE_EMPLOYEE':
    case 'EMPLOYEE_ISSUE':
    case 'EMPLOYEE':
      return 'ISSUE_EMPLOYEE';
    case 'ISSUE_REPAIR':
    case 'REPAIR':
    case 'GOING_TO_REPAIR':
      return 'ISSUE_REPAIR';
    case 'ISSUE_SCRAP':
    case 'SCRAPPED':
    case 'SCRAP':
    case 'CONSUMED':
    case 'DAMAGE':
    case 'DAMAGED':
      return 'ISSUE_SCRAP';
    case 'RETURN_SITE':
    case 'RETURN':
      return 'RETURN_SITE';
    case 'RETURN_EMPLOYEE':
      return 'RETURN_EMPLOYEE';
    case 'RETURN_REPAIR':
      return 'RETURN_REPAIR';
    case 'RETURN_NEW':
    case 'NEW':
      return 'RETURN_NEW';
    case 'SITE_TRANSFER':
    case 'SITE TRANSFER':
      return 'SITE TRANSFER';
    case 'DELIVERY':
      return 'DELIVERY';
    default:
      return upper;
  }
}

function isStockOutTransaction(type) {
  const normalized = normalizeTransactionType(type);
  return (
    normalized === 'ISSUE_SITE' ||
    normalized === 'ISSUE_EMPLOYEE' ||
    normalized === 'ISSUE_REPAIR' ||
    normalized === 'ISSUE_SCRAP'
  );
}

function isStockInTransaction(type) {
  const normalized = normalizeTransactionType(type);
  return (
    normalized === 'RETURN_SITE' ||
    normalized === 'RETURN_EMPLOYEE' ||
    normalized === 'RETURN_REPAIR' ||
    normalized === 'RETURN_NEW' ||
    normalized === 'DELIVERY'
  );
}

module.exports = {
  VALID_TRANSACTION_TYPES,
  isStockInTransaction,
  isStockOutTransaction,
  normalizeTransactionType,
};

