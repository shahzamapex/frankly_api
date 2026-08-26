// api/cleanup-cloudinary-orphans.js
/**
 * Cloudinary Orphaned Image Cleanup Tool
 * 
 * Safely finds and deletes Cloudinary images that are no longer referenced anywhere in the Supabase database.
 * 
 * Usage:
 *   node cleanup-cloudinary-orphans.js           -> Dry-run (scans & reports unused images without deleting)
 *   node cleanup-cloudinary-orphans.js --delete  -> Deletes orphaned images permanently
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const cloudinary = require('cloudinary').v2;
const { getSupabaseAdmin } = require('./src/lib/supabase');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'daoummcel',
  api_key: process.env.CLOUDINARY_API_KEY || '359941915345927',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'my0lB_-mevYyarmob6sZsa4fquo',
});

function extractCloudinaryPublicId(urlOrId) {
  if (!urlOrId || typeof urlOrId !== 'string') return null;
  const str = urlOrId.trim();
  if (!str) return null;

  if (!str.includes('cloudinary.com')) {
    if (str.startsWith('http')) return null;
    return str.replace(/\.[^/.]+$/, '');
  }

  try {
    const match = str.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?$/);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  } catch (_) {}

  return null;
}

function findUrlsInObject(obj, foundUrls = new Set()) {
  if (!obj) return foundUrls;

  if (typeof obj === 'string') {
    if (obj.includes('cloudinary.com') || obj.includes('inventory/')) {
      foundUrls.add(obj.trim());
      const publicId = extractCloudinaryPublicId(obj);
      if (publicId) foundUrls.add(publicId);
    }
    return foundUrls;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      findUrlsInObject(item, foundUrls);
    }
    return foundUrls;
  }

  if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      findUrlsInObject(obj[key], foundUrls);
    }
  }

  return foundUrls;
}

async function fetchAllDatabaseImageReferences(supabase, logFn) {
  logFn('🔍 Querying active database records for image references...');
  const referencedIds = new Set();
  const referencedUrls = new Set();

  // Protect system default assets
  const protectedSystemUrls = [
    'https://res.cloudinary.com/daoummcel/image/upload/v1774943434/logo_oqzyhe.png',
    'https://res.cloudinary.com/daoummcel/image/upload/v1787262014/system/user.png',
  ];
  for (const url of protectedSystemUrls) {
    referencedUrls.add(url);
    const pid = extractCloudinaryPublicId(url);
    if (pid) referencedIds.add(pid);
  }

  const tables = [
    'inventories',
    'sites',
    'users',
    'transactions',
  ];

  for (const table of tables) {
    try {
      const { data, error } = await supabase.from(table).select('*');
      if (error) {
        logFn(`  ⚠️ Table "${table}" query notice: ${error.message}`);
        continue;
      }

      if (data && data.length > 0) {
        logFn(`  ✓ Loaded ${data.length} records from "${table}"`);
        const found = findUrlsInObject(data);
        for (const item of found) {
          referencedUrls.add(item);
          const pid = extractCloudinaryPublicId(item);
          if (pid) referencedIds.add(pid);
        }
      }
    } catch (e) {
      logFn(`  ⚠️ Error querying "${table}": ${e.message}`);
    }
  }

  logFn(`\n📊 Total unique active DB image references found: ${referencedIds.size}`);
  return { referencedIds, referencedUrls };
}

async function fetchAllCloudinaryAssets(logFn) {
  logFn('\n☁️ Fetching asset catalog from Cloudinary...');
  const assets = [];
  let nextCursor = null;

  do {
    const options = {
      resource_type: 'image',
      max_results: 500,
      next_cursor: nextCursor,
    };

    const result = await cloudinary.api.resources(options);
    if (result.resources && result.resources.length > 0) {
      assets.push(...result.resources);
      if (process.stdout && process.stdout.isTTY) {
        process.stdout.write(`  Fetched ${assets.length} assets so far...\r`);
      }
    }
    nextCursor = result.next_cursor;
  } while (nextCursor);

  logFn(`\n📊 Total assets in Cloudinary: ${assets.length}`);
  return assets;
}

async function runCloudinaryOrphanCleanup({ isDeleteMode = true, silent = false } = {}) {
  const logs = [];
  const logFn = (msg) => {
    logs.push(msg);
    if (!silent) {
      console.log(msg);
    }
  };

  logFn('====================================================');
  logFn('🧹 Cloudinary Orphaned Image Cleanup Tool');
  logFn(`Mode: ${isDeleteMode ? '🚨 PERMANENT DELETION (--delete)' : '🛡️ DRY-RUN (No files will be deleted)'}`);
  logFn('====================================================\n');

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (err) {
    const errorMsg = `❌ Failed to initialize Supabase Admin client: ${err.message}`;
    logFn(errorMsg);
    return {
      status: 'error',
      error: errorMsg,
      logs,
      report: logs.join('\n'),
    };
  }

  const { referencedIds, referencedUrls } = await fetchAllDatabaseImageReferences(supabase, logFn);
  const assets = await fetchAllCloudinaryAssets(logFn);

  // Find orphaned assets
  const orphanedAssets = [];
  let totalOrphanedBytes = 0;

  for (const asset of assets) {
    const publicId = asset.public_id;
    const secureUrl = asset.secure_url;
    const url = asset.url;

    const isReferenced =
      referencedIds.has(publicId) ||
      referencedUrls.has(publicId) ||
      referencedUrls.has(secureUrl) ||
      referencedUrls.has(url) ||
      Array.from(referencedUrls).some(
        (ref) => ref.includes(publicId) || publicId.includes(ref)
      );

    if (!isReferenced) {
      orphanedAssets.push(asset);
      totalOrphanedBytes += asset.bytes || 0;
    }
  }

  const orphanedMb = (totalOrphanedBytes / (1024 * 1024)).toFixed(2);

  logFn('\n====================================================');
  logFn('📋 AUDIT RESULTS:');
  logFn(`  • Total Cloudinary Assets:  ${assets.length}`);
  logFn(`  • In-Use (Active in DB):    ${assets.length - orphanedAssets.length}`);
  logFn(`  • Orphaned (Not in DB):     ${orphanedAssets.length}`);
  logFn(`  • Storage Recoverable:      ${orphanedMb} MB`);
  logFn('====================================================\n');

  const orphanedList = orphanedAssets.map((asset) => ({
    publicId: asset.public_id,
    sizeKb: `${((asset.bytes || 0) / 1024).toFixed(1)} KB`,
    url: asset.secure_url || asset.url,
  }));

  if (orphanedAssets.length === 0) {
    logFn('✨ All Cloudinary images are in active use! No cleanup needed.');
    return {
      status: 'completed',
      mode: isDeleteMode ? 'delete' : 'dry-run',
      totalCloudinaryAssets: assets.length,
      activeInDb: assets.length,
      orphanedCount: 0,
      deletedCount: 0,
      storageFreedMb: '0.00 MB',
      orphanedFiles: [],
      logs,
      report: logs.join('\n'),
    };
  }

  logFn('Preview of orphaned files:');
  orphanedAssets.slice(0, 15).forEach((asset, i) => {
    const sizeKb = ((asset.bytes || 0) / 1024).toFixed(1);
    logFn(`  [${i + 1}] ${asset.public_id} (${sizeKb} KB) - ${asset.secure_url}`);
  });
  if (orphanedAssets.length > 15) {
    logFn(`  ... and ${orphanedAssets.length - 15} more.`);
  }

  if (!isDeleteMode) {
    logFn('\n💡 TO DELETE THESE ORPHANED IMAGES:');
    logFn('Run the script with the --delete flag:');
    logFn('  node cleanup-cloudinary-orphans.js --delete\n');
    return {
      status: 'completed',
      mode: 'dry-run',
      totalCloudinaryAssets: assets.length,
      activeInDb: assets.length - orphanedAssets.length,
      orphanedCount: orphanedAssets.length,
      deletedCount: 0,
      storageRecoverableMb: `${orphanedMb} MB`,
      orphanedFiles: orphanedList,
      logs,
      report: logs.join('\n'),
    };
  }

  // Deletion execution
  logFn(`\n🚨 Starting deletion of ${orphanedAssets.length} orphaned images in batches of 100...`);
  const publicIdsToDelete = orphanedAssets.map((a) => a.public_id);
  const batchSize = 100;
  let deletedCount = 0;

  for (let i = 0; i < publicIdsToDelete.length; i += batchSize) {
    const batch = publicIdsToDelete.slice(i, i + batchSize);
    try {
      const deleteResult = await cloudinary.api.delete_resources(batch);
      const successful = Object.values(deleteResult.deleted || {}).filter(
        (status) => status === 'deleted'
      ).length;
      deletedCount += successful;
      logFn(`  ✓ Deleted batch ${Math.floor(i / batchSize) + 1} (${successful}/${batch.length} deleted)`);
    } catch (delErr) {
      logFn(`  ❌ Error deleting batch ${Math.floor(i / batchSize) + 1}: ${delErr.message}`);
    }
  }

  logFn(`\n🎉 Cleanup complete! Successfully deleted ${deletedCount} unused images (${orphanedMb} MB freed).`);

  return {
    status: 'completed',
    mode: 'delete',
    totalCloudinaryAssets: assets.length,
    activeInDb: assets.length - orphanedAssets.length,
    orphanedCount: orphanedAssets.length,
    deletedCount,
    storageFreedMb: `${orphanedMb} MB`,
    orphanedFiles: orphanedList,
    logs,
    report: logs.join('\n'),
  };
}

// Standalone CLI execution
if (require.main === module) {
  const isDeleteMode = process.argv.includes('--delete');
  runCloudinaryOrphanCleanup({ isDeleteMode })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n❌ Unhandled error:', err);
      process.exit(1);
    });
}

module.exports = {
  runCloudinaryOrphanCleanup,
};
