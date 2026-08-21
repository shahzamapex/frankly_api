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

const isDeleteMode = process.argv.includes('--delete');

function extractCloudinaryPublicId(urlOrId) {
  if (!urlOrId || typeof urlOrId !== 'string') return null;
  const str = urlOrId.trim();
  if (!str) return null;

  if (!str.includes('cloudinary.com')) {
    // Might already be a public_id
    if (str.startsWith('http')) return null;
    return str.replace(/\.[^/.]+$/, '');
  }

  try {
    // Match .../upload/(v[0-9]+/)?(folder/)?(name)
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

async function fetchAllDatabaseImageReferences(supabase) {
  console.log('🔍 Querying active database records for image references...');
  const referencedIds = new Set();
  const referencedUrls = new Set();

  const tables = [
    'inventories',
    'sites',
    'users',
    'transactions',
    'deliveries',
    'app_configs',
    'vendors',
  ];

  for (const table of tables) {
    try {
      const { data, error } = await supabase.from(table).select('*');
      if (error) {
        // Table might not exist or be named differently, continue gracefully
        console.warn(`  ⚠️ Table "${table}" query notice: ${error.message}`);
        continue;
      }

      if (data && data.length > 0) {
        console.log(`  ✓ Loaded ${data.length} records from "${table}"`);
        const found = findUrlsInObject(data);
        for (const item of found) {
          referencedUrls.add(item);
          const pid = extractCloudinaryPublicId(item);
          if (pid) referencedIds.add(pid);
        }
      }
    } catch (e) {
      console.warn(`  ⚠️ Error querying "${table}":`, e.message);
    }
  }

  console.log(`\n📊 Total unique active DB image references found: ${referencedIds.size}`);
  return { referencedIds, referencedUrls };
}

async function fetchAllCloudinaryAssets() {
  console.log('\n☁️ Fetching asset catalog from Cloudinary...');
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
      process.stdout.write(`  Fetched ${assets.length} assets so far...\r`);
    }
    nextCursor = result.next_cursor;
  } while (nextCursor);

  console.log(`\n📊 Total assets in Cloudinary: ${assets.length}`);
  return assets;
}

async function run() {
  console.log('====================================================');
  console.log('🧹 Cloudinary Orphaned Image Cleanup Tool');
  console.log(`Mode: ${isDeleteMode ? '🚨 PERMANENT DELETION (--delete)' : '🛡️ DRY-RUN (No files will be deleted)'}`);
  console.log('====================================================\n');

  let supabase;
  try {
    supabase = getSupabaseAdmin();
  } catch (err) {
    console.error('❌ Failed to initialize Supabase Admin client:', err.message);
    process.exit(1);
  }

  const { referencedIds, referencedUrls } = await fetchAllDatabaseImageReferences(supabase);
  const assets = await fetchAllCloudinaryAssets();

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

  console.log('\n====================================================');
  console.log('📋 AUDIT RESULTS:');
  console.log(`  • Total Cloudinary Assets:  ${assets.length}`);
  console.log(`  • In-Use (Active in DB):    ${assets.length - orphanedAssets.length}`);
  console.log(`  • Orphaned (Not in DB):     ${orphanedAssets.length}`);
  console.log(`  • Storage Recoverable:      ${orphanedMb} MB`);
  console.log('====================================================\n');

  if (orphanedAssets.length === 0) {
    console.log('✨ All Cloudinary images are in active use! No cleanup needed.');
    return;
  }

  console.log('Preview of orphaned files:');
  orphanedAssets.slice(0, 15).forEach((asset, i) => {
    const sizeKb = ((asset.bytes || 0) / 1024).toFixed(1);
    console.log(`  [${i + 1}] ${asset.public_id} (${sizeKb} KB) - ${asset.secure_url}`);
  });
  if (orphanedAssets.length > 15) {
    console.log(`  ... and ${orphanedAssets.length - 15} more.`);
  }

  if (!isDeleteMode) {
    console.log('\n💡 TO DELETE THESE ORPHANED IMAGES:');
    console.log('Run the script with the --delete flag:');
    console.log('  node cleanup-cloudinary-orphans.js --delete\n');
    return;
  }

  // Deletion execution
  console.log(`\n🚨 Starting deletion of ${orphanedAssets.length} orphaned images in batches of 100...`);
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
      console.log(`  ✓ Deleted batch ${Math.floor(i / batchSize) + 1} (${successful}/${batch.length} deleted)`);
    } catch (delErr) {
      console.error(`  ❌ Error deleting batch ${Math.floor(i / batchSize) + 1}:`, delErr.message);
    }
  }

  console.log(`\n🎉 Cleanup complete! Successfully deleted ${deletedCount} unused images (${orphanedMb} MB freed).`);
}

run().catch((err) => {
  console.error('\n❌ Unhandled error:', err);
  process.exit(1);
});
