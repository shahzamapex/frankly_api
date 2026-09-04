const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

const { getSupabaseAdmin } = require('../lib/supabase');
const { fetchMany, updateRow } = require('../lib/db');

function formatDateTimeStamp(date) {
  const d = date instanceof Date ? date : new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}${mm}${yy}${hh}${min}`;
}

async function runMigration() {
  console.log('--- Starting Transaction ID Migration ---');
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    console.error('Failed to initialize Supabase client. Check your .env file.');
    process.exit(1);
  }

  // Fetch all transactions
  const rows = await fetchMany('transactions', {
    limit: 100000,
  });

  console.log(`Fetched ${rows.length} transactions total.`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const row of rows) {
    const existingTxnId = row.transactionId || row.transaction_id;
    if (existingTxnId && String(existingTxnId).trim().length > 0) {
      skippedCount++;
      continue;
    }

    // Determine fallback
    const fallbackId =
      row.deliveryId ||
      row.delivery_id ||
      row.batchId ||
      row.batch_id ||
      `TXN-${formatDateTimeStamp(row.eventTimestamp || row.createdAt || new Date())}`;

    const id = row.id || row._id;
    try {
      await updateRow('transactions', id, {
        transactionId: fallbackId,
      });
      updatedCount++;
      if (updatedCount % 50 === 0) {
        console.log(`Migrated ${updatedCount} records...`);
      }
    } catch (err) {
      console.error(`Failed to update transaction ${id}:`, err.message);
    }
  }

  console.log('--- Migration Completed ---');
  console.log(`Total checked: ${rows.length}`);
  console.log(`Updated: ${updatedCount}`);
  console.log(`Skipped (already had transactionId): ${skippedCount}`);
}

runMigration().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
