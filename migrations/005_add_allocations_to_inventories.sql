-- ===========================================================================
-- Migration 005: Add 'allocations' JSONB list column to inventories
-- ===========================================================================
-- Stores project / villa allocations directly on each inventory item.
-- Structure: [
--   {
--     "site_id": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d",
--     "site_name": "Villa 79",
--     "quantity": 20,
--     "notes": "Allocated for villa plumbing",
--     "allocated_at": "2026-11-12T01:00:00.000Z",
--     "allocated_by": "StoreKeeper"
--   }
-- ]
--
-- This removes any need for fake RESERVE transactions in the transactions
-- table and allows instant, clean allocation tracking in the inventory table.
-- ===========================================================================

ALTER TABLE public.inventories
  ADD COLUMN IF NOT EXISTS allocations jsonb DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.inventories.allocations IS
  'List of earmarked project/villa allocations directly on the item, e.g. [{"site_id": "...", "site_name": "Villa 79", "quantity": 20}]';
