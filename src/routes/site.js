const express = require('express');
const { ID_COLUMN, fetchById, fetchMany, insertRow, indexById, uniqueIds, updateRow } = require('../lib/db');
const checkPermission = require('../middlewares/checkPermission');
const { logAudit } = require('../lib/auditLogger');

const router = express.Router();

function normalizeSiteIdentity(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeSiteType(type, siteCode, siteName) {
  const t = normalizeSiteIdentity(type);
  const c = normalizeSiteIdentity(siteCode);
  const n = normalizeSiteIdentity(siteName);

  if (t === 'WAREHOUSE' || c === 'WAREHOUSE' || n === 'WAREHOUSE') return 'WAREHOUSE';
  if (t === 'SCRAPPED' || t === 'SCRAP' || c === 'SCRAPPED' || c === 'SCRAP' || n === 'SCRAPPED' || n === 'SCRAP') return 'SCRAPPED';
  if (t === 'CAMP' || t === 'LABOUR_CAMP' || t === 'LABOR_CAMP' || c === 'CAMP' || c === 'LC' || n === 'LABOUR CAMP' || n === 'LABOR CAMP') return 'CAMP';
  if (t === 'VENDOR' || t === 'SUPPLIER' || t === 'REPAIR' || t === 'REPAIR_WORKSHOP' || t === 'WORKSHOP') return 'VENDOR';
  return t || 'PROJECT';
}

function isWarehouseSite(site) {
  return normalizeSiteType(site?.type, site?.siteCode, site?.siteName || site?.name) === 'WAREHOUSE';
}

function isScrappedSite(site) {
  return normalizeSiteType(site?.type, site?.siteCode, site?.siteName || site?.name) === 'SCRAPPED';
}

function isCampSite(site) {
  return normalizeSiteType(site?.type, site?.siteCode, site?.siteName || site?.name) === 'CAMP';
}

async function ensureDefaultSites() {
  try {
    const sites = await fetchMany('sites').catch(() => []);
    const hasWarehouse = sites.some(isWarehouseSite);
    const hasScrapped = sites.some(isScrappedSite);
    const hasCamp = sites.some(isCampSite);

    if (!hasWarehouse) {
      await insertRow('sites', {
        siteCode: 'WH',
        siteName: 'Warehouse',
        type: 'WAREHOUSE',
        status: 'active',
      }).catch(() => {});
    }

    if (!hasScrapped) {
      await insertRow('sites', {
        siteCode: 'SCRAP',
        siteName: 'Scrapped',
        type: 'SCRAPPED',
        status: 'active',
      }).catch(() => {});
    }

    if (!hasCamp) {
      await insertRow('sites', {
        siteCode: 'CAMP',
        siteName: 'Labour Camp',
        type: 'CAMP',
        status: 'active',
      }).catch(() => {});
    }
  } catch (_) {}
}

async function fetchUserSummaries(ids) {
  const userIds = uniqueIds(ids);
  if (!userIds.length) {
    return new Map();
  }

  const users = await fetchMany('users', {
    filters: [{ column: ID_COLUMN, operator: 'in', value: userIds }],
  });

  return indexById(users.map((user) => ({
    _id: user._id,
    username: user.username,
    fullName: user.fullName,
  })));
}

async function populateSite(site) {
  if (!site) {
    return null;
  }

  const userMap = await fetchUserSummaries([site.engineerId, site.siteManager]);
  const type = normalizeSiteType(site.type, site.siteCode, site.siteName || site.name);
  const imageUrl = (site.imageUrl && String(site.imageUrl).trim())
    ? site.imageUrl
    : null;

  return {
    ...site,
    type,
    imageUrl,
    client: site.clientName ? { name: site.clientName } : null,
    projectValue: site.projectValue !== undefined || site.projectCurrency
      ? { amount: site.projectValue, currency: site.projectCurrency }
      : null,
    workingHours: site.workingHoursStart || site.workingHoursEnd
      ? { start: site.workingHoursStart, end: site.workingHoursEnd }
      : null,
    engineer: site.engineerId ? (userMap.get(String(site.engineerId)) || site.engineerId) : site.engineerId,
    siteManager: site.siteManager ? (userMap.get(String(site.siteManager)) || site.siteManager) : site.siteManager,
    safetyOfficer: null,
  };
}

async function populateSites(sites) {
  const ids = uniqueIds(sites.flatMap((site) => [site.engineerId, site.siteManager]));

  const userMap = await fetchUserSummaries(ids);

  return sites.map((site) => {
    const type = normalizeSiteType(site.type, site.siteCode, site.siteName || site.name);
    const imageUrl = (site.imageUrl && String(site.imageUrl).trim())
      ? site.imageUrl
      : null;

    return {
      ...site,
      type,
      imageUrl,
      client: site.clientName ? { name: site.clientName } : null,
      projectValue: site.projectValue !== undefined || site.projectCurrency
        ? { amount: site.projectValue, currency: site.projectCurrency }
        : null,
      workingHours: site.workingHoursStart || site.workingHoursEnd
        ? { start: site.workingHoursStart, end: site.workingHoursEnd }
        : null,
      engineer: site.engineerId ? (userMap.get(String(site.engineerId)) || site.engineerId) : site.engineerId,
      siteManager: site.siteManager ? (userMap.get(String(site.siteManager)) || site.siteManager) : site.siteManager,
      safetyOfficer: null,
    };
  });
}

function normalizeSitePayload(body) {
  const payload = { ...body };

  payload.type = normalizeSiteType(payload.type, payload.siteCode, payload.siteName);

  if (body.phone !== undefined || body.phoneNumber !== undefined || body.phone_number !== undefined) {
    const rawPhone = body.phone ?? body.phoneNumber ?? body.phone_number;
    payload.phone = rawPhone ? String(rawPhone).trim() : null;
  }

  if (payload.client && !payload.clientName) {
    payload.clientName = typeof payload.client === 'string' ? payload.client : payload.client.name;
  }

  if (payload.projectValue && typeof payload.projectValue === 'object') {
    if (payload.projectValue.amount !== undefined && payload.projectValue.amount !== null && payload.projectValue.amount !== '') {
      payload.projectValue = Number(payload.projectValue.amount);
    } else {
      delete payload.projectValue;
    }

    if (payload.projectValue?.currency || body.projectValue?.currency) {
      payload.projectCurrency = body.projectValue.currency;
    }
  } else if (payload.projectValue !== undefined && payload.projectValue !== null && payload.projectValue !== '') {
    payload.projectValue = Number(payload.projectValue);
  }

  if (payload.workingHours && typeof payload.workingHours === 'object') {
    payload.workingHoursStart = payload.workingHours.start;
    payload.workingHoursEnd = payload.workingHours.end;
  }

  if (payload.engineer && !payload.engineerId) {
    payload.engineerId = typeof payload.engineer === 'object'
      ? (payload.engineer.id || payload.engineer._id)
      : payload.engineer;
  }

  if (payload.siteManager) {
    payload.siteManager = typeof payload.siteManager === 'object'
      ? (payload.siteManager.id || payload.siteManager._id)
      : payload.siteManager;
  }

  delete payload.client;
  delete payload.workingHours;
  delete payload.engineer;
  delete payload.safetyOfficer;
  delete payload.createdAt;
  delete payload.updatedAt;

  return payload;
}

router.post('/', checkPermission('addSites'), async (req, res) => {
  try {
    if (!req.body.siteCode || !req.body.siteName) {
      return res.status(400).json({ error: 'Site code and name are required' });
    }

    const payload = normalizeSitePayload(req.body);
    if (isWarehouseSite(payload)) {
      payload.siteCode = 'WAREHOUSE';
      payload.siteName = 'Warehouse';
      payload.type = 'WAREHOUSE';
      payload.status = 'active';
    } else if (isScrappedSite(payload)) {
      payload.siteCode = 'SCRAP';
      payload.siteName = 'Scrapped';
      payload.type = 'SCRAPPED';
      payload.status = 'active';
    }

    const site = await insertRow('sites', payload);
    const populated = await populateSite(site);

    logAudit({
      action: 'ADD_SITE',
      entityType: 'site',
      entityId: site.id || site._id,
      user: req.user,
      req,
      previousValue: null,
      newValue: populated || site,
      details: `Added site: ${site.siteName || payload.siteName} (${site.siteCode || payload.siteCode})`,
    }).catch((err) => console.error('[AuditLog] Add site log error:', err));

    invalidateSitesCache();
    res.status(201).json(populated);
  } catch (err) {
    console.error('Create site error:', err);
    res.status(400).json({ error: 'Failed to create site' });
  }
});

let _cachedSites = null;
let _cachedSitesTime = 0;
const SITES_CACHE_TTL = 3 * 60 * 1000; // 3 minutes

function invalidateSitesCache() {
  _cachedSites = null;
  _cachedSitesTime = 0;
}

router.get('/', checkPermission('viewSites'), async (req, res) => {
  try {
    const now = Date.now();
    if (_cachedSites && (now - _cachedSitesTime < SITES_CACHE_TTL)) {
      return res.json(_cachedSites);
    }
    await ensureDefaultSites();
    const sites = await fetchMany('sites');
    const populated = await populateSites(sites);
    _cachedSites = populated;
    _cachedSitesTime = now;
    res.json(populated);
  } catch (err) {
    console.error('Get sites error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', checkPermission('viewSites'), async (req, res) => {
  try {
    const site = await fetchById('sites', req.params.id);
    if (!site) return res.status(404).json({ error: 'Site not found' });
    res.json(await populateSite(site));
  } catch (err) {
    console.error('Get site error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', checkPermission('editSites'), async (req, res) => {
  try {
    const existing = await fetchById('sites', req.params.id);
    if (!existing) return res.status(404).json({ error: 'Site not found' });

    if (isWarehouseSite(existing) || isScrappedSite(existing)) {
      return res.status(403).json({
        error: 'System locations (Warehouse and Scrapped) are permanent and read-only.',
      });
    }

    const updates = normalizeSitePayload(req.body);
    delete updates._id;
    delete updates.id;

    const updated = await updateRow('sites', req.params.id, updates);
    if (!updated) return res.status(404).json({ error: 'Site not found' });

    const populated = await populateSite(updated);

    logAudit({
      action: 'EDIT_SITE',
      entityType: 'site',
      entityId: req.params.id,
      user: req.user,
      req,
      previousValue: existing,
      newValue: populated || updated,
      details: `Edited site: ${updated.siteName || existing.siteName} (${updated.siteCode || existing.siteCode})`,
    }).catch((err) => console.error('[AuditLog] Edit site log error:', err));

    invalidateSitesCache();
    res.json(populated);
  } catch (err) {
    console.error('Update site error:', err);
    res.status(400).json({ error: 'Failed to update site' });
  }
});

router.delete('/:id', checkPermission('deleteSites'), async (req, res) => {
  return res.status(403).json({
    error: 'Site deletion is disabled. Sites cannot be deleted.',
  });
});

module.exports = router;
