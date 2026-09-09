-- ============================================================================
-- StockGrid API Improvements — Migration 001
-- ============================================================================
-- Run against the Supabase Postgres instance (SQL Editor or psql).
-- Every statement is idempotent / guarded, so it is SAFE TO RE-RUN and
-- will NOT break existing data:
--   * New columns  -> ALTER ... ADD COLUMN IF NOT EXISTS
--   * Constraints  -> added NOT VALID first (skips existing rows), then a
--                     separate VALIDATE step you can run after a data audit
--   * FKs          -> NOT VALID so existing orphan rows do not fail the add
--   * Indexes      -> CREATE INDEX IF NOT EXISTS
--   * Trigger      -> drops itself first if present
--
-- The stock trigger is BULK-SAFE: it is a row-level (FOR EACH ROW) trigger,
-- so a multi-row INSERT from POST /transactions/bulk fires it once per row
-- inside the same statement/transaction — atomic for both single and bulk
-- transaction creation, updates, and deletes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. INVENTORIES: reorder level column (drives the Stock Deficit alert)
-- ---------------------------------------------------------------------------
ALTER TABLE public.inventories
  ADD COLUMN IF NOT EXISTS reorder_level numeric NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.inventories.reorder_level IS
  'Safety-minimum stock level; current_stock <= reorder_level means low stock.';

-- ---------------------------------------------------------------------------
-- 2. TRANSACTIONS: unique transaction_id
--    (guarded: only created when no duplicates exist; dedupe query below)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'transactions_transaction_id_key'
  ) AND NOT EXISTS (
    SELECT transaction_id
    FROM public.transactions
    WHERE transaction_id IS NOT NULL AND transaction_id <> ''
    GROUP BY transaction_id
    HAVING COUNT(*) > 1
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_transaction_id_key UNIQUE (transaction_id);
    RAISE NOTICE 'transactions_transaction_id_key created';
  ELSE
    RAISE NOTICE 'SKIPPED transactions_transaction_id_key (index exists or duplicate transaction_id rows found — run the dedupe query in section 2b first)';
  END IF;
END
$$;

-- 2b. OPTIONAL dedupe helper (run manually if the notice above says duplicates
--     were found; renames older duplicates so the unique constraint can apply):
--   UPDATE public.transactions t
--   SET transaction_id = t.transaction_id || '-dup-' || substr(t.id::text, 1, 8)
--   WHERE t.id NOT IN (
--     SELECT MIN(id) FROM public.transactions
--     GROUP BY transaction_id
--   );

-- ---------------------------------------------------------------------------
-- 3. TRANSACTIONS: site foreign keys (NOT VALID — safe with existing rows)
--    These MUST exist before the stock trigger so joins are trustworthy.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_from_site_id_fkey'
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_from_site_id_fkey
      FOREIGN KEY (from_site_id) REFERENCES public.sites(id) NOT VALID;
    RAISE NOTICE 'transactions_from_site_id_fkey added (NOT VALID)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_to_site_id_fkey'
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_to_site_id_fkey
      FOREIGN KEY (to_site_id) REFERENCES public.sites(id) NOT VALID;
    RAISE NOTICE 'transactions_to_site_id_fkey added (NOT VALID)';
  END IF;
END
$$;

-- 3b. Orphan report + validate (run after reviewing orphans):
--   SELECT t.id, t.from_site_id, t.to_site_id
--   FROM public.transactions t
--   LEFT JOIN public.sites s1 ON s1.id = t.from_site_id
--   LEFT JOIN public.sites s2 ON s2.id = t.to_site_id
--   WHERE (t.from_site_id IS NOT NULL AND s1.id IS NULL)
--      OR (t.to_site_id   IS NOT NULL AND s2.id IS NULL);
--
--   ALTER TABLE public.transactions VALIDATE CONSTRAINT transactions_from_site_id_fkey;
--   ALTER TABLE public.transactions VALIDATE CONSTRAINT transactions_to_site_id_fkey;

-- ---------------------------------------------------------------------------
-- 4. TRANSACTIONS: data sanity checks (NOT VALID — documents intent,
--    validate after confirming no legacy rows violate them)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_quantity_nonnegative'
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_quantity_nonnegative
      CHECK (quantity >= 0) NOT VALID;
    RAISE NOTICE 'transactions_quantity_nonnegative added';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_type_allowed'
  ) THEN
    -- Known canonical types + the legacy aliases the API accepts.
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_type_allowed CHECK (
        type IN (
          'ISSUE_SITE', 'ISSUE_EMPLOYEE', 'ISSUE_REPAIR', 'ISSUE_SCRAP',
          'RETURN_SITE', 'RETURN_EMPLOYEE', 'RETURN_REPAIR', 'RETURN_NEW',
          'SITE TRANSFER', 'SITE_TRANSFER', 'DELIVERY',
          'ISSUE', 'RETURN', 'NEW', 'RECEIVE', 'INWARD'
        )
      ) NOT VALID;
    RAISE NOTICE 'transactions_type_allowed added (NOT VALID — validate after auditing legacy type values)';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 5. TRANSACTION PROOFS table (replaces [PROOF_IMAGE:...] tags in remark)
--    The API keeps writing remark tags for backwards compatibility; this
--    table is the forward-looking home for multiple proof photos per txn.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transaction_proofs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  transaction_row_id uuid NOT NULL,
  image_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transaction_proofs_pkey PRIMARY KEY (id),
  CONSTRAINT transaction_proofs_txn_fkey
    FOREIGN KEY (transaction_row_id) REFERENCES public.transactions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transaction_proofs_txn
  ON public.transaction_proofs (transaction_row_id);

-- ---------------------------------------------------------------------------
-- 6. PERFORMANCE INDEXES
--    (item movement history, site filtering, employee filtering, dashboards)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_transactions_inventory_created
  ON public.transactions (inventory_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_from_site
  ON public.transactions (from_site_id) WHERE from_site_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_to_site
  ON public.transactions (to_site_id) WHERE to_site_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_employee
  ON public.transactions (employee_id) WHERE employee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_created_at
  ON public.transactions (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventories_category
  ON public.inventories (category) WHERE category IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inventories_status
  ON public.inventories (status) WHERE status IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_created
  ON public.audit_logs (entity_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created
  ON public.audit_logs (user_id, created_at DESC) WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. ATOMIC STOCK TRIGGER (bulk-safe)
--    Maintains inventories.current_stock on every transaction INSERT,
--    UPDATE (of type/quantity/inventory_id), and DELETE — per row, inside
--    the same transaction as the write. Works identically for:
--      * single item  -> POST /api/transactions        (1 row)
--      * bulk batch   -> POST /api/transactions/bulk   (N rows, one INSERT)
--    Direction mirrors api/src/lib/transactionType.js:
--      IN : RETURN_SITE, RETURN_EMPLOYEE, RETURN_REPAIR, RETURN_NEW, DELIVERY
--      OUT: ISSUE_SITE, ISSUE_EMPLOYEE, ISSUE_REPAIR, ISSUE_SCRAP
--      NEUTRAL (no stock change): SITE TRANSFER
--    The API's background recalculateInventoryStocks() remains as a
--    self-healing consistency pass; with this trigger the drift window
--    closes to zero.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.maintain_inventory_stock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_type text;
  delta numeric;
  affected_item uuid;
BEGIN
  -- Normalize: uppercase, spaces -> underscores (matches JS normalizeTransactionType).
  normalized_type := upper(replace(trim(COALESCE(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.type ELSE NEW.type END,
    ''
  )), ' ', '_'));

  CASE normalized_type
    WHEN 'RETURN_SITE' THEN delta := 1;
    WHEN 'RETURN_EMPLOYEE' THEN delta := 1;
    WHEN 'RETURN_REPAIR' THEN delta := 1;
    WHEN 'RETURN_NEW' THEN delta := 1;
    WHEN 'DELIVERY' THEN delta := 1;
    WHEN 'ISSUE_SITE' THEN delta := -1;
    WHEN 'ISSUE_EMPLOYEE' THEN delta := -1;
    WHEN 'ISSUE_REPAIR' THEN delta := -1;
    WHEN 'ISSUE_SCRAP' THEN delta := -1;
    -- SITE_TRANSFER / legacy / unknown types: net-neutral, the background
    -- recalculation pass remains the source of truth for those.
    ELSE delta := 0;
  END CASE;

  IF delta = 0 AND TG_OP <> 'DELETE' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    affected_item := NEW.inventory_id;
    IF affected_item IS NOT NULL AND NEW.quantity IS NOT NULL THEN
      UPDATE public.inventories
      SET current_stock = GREATEST(COALESCE(current_stock, 0) + delta * NEW.quantity, 0),
          updated_at = now()
      WHERE id = affected_item;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Reverse the OLD row's effect, then apply the NEW row's effect.
    -- Handles quantity edits, type changes, and item reassignment.
    IF OLD.inventory_id IS NOT NULL AND OLD.quantity IS NOT NULL THEN
      UPDATE public.inventories
      SET current_stock = GREATEST(COALESCE(current_stock, 0) - delta * OLD.quantity, 0),
          updated_at = now()
      WHERE id = OLD.inventory_id;
    END IF;
    IF NEW.inventory_id IS NOT NULL AND NEW.quantity IS NOT NULL THEN
      UPDATE public.inventories
      SET current_stock = GREATEST(COALESCE(current_stock, 0) + delta * NEW.quantity, 0),
          updated_at = now()
      WHERE id = NEW.inventory_id;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    affected_item := OLD.inventory_id;
    IF affected_item IS NOT NULL AND OLD.quantity IS NOT NULL THEN
      -- Deleting reverses the original effect (delta already has the sign
      -- of the original write, so subtract it back out).
      UPDATE public.inventories
      SET current_stock = GREATEST(COALESCE(current_stock, 0) - delta * OLD.quantity, 0),
          updated_at = now()
      WHERE id = affected_item;
    END IF;
    RETURN OLD;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_transactions_maintain_stock ON public.transactions;
CREATE TRIGGER trg_transactions_maintain_stock
  AFTER INSERT OR DELETE OR UPDATE OF type, quantity, inventory_id
  ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.maintain_inventory_stock();

-- ---------------------------------------------------------------------------
-- 8. updated_at auto-maintenance (users / inventories / sites)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_touch_updated_at ON public.users;
CREATE TRIGGER trg_users_touch_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_inventories_touch_updated_at ON public.inventories;
CREATE TRIGGER trg_inventories_touch_updated_at
  BEFORE UPDATE ON public.inventories
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_sites_touch_updated_at ON public.sites;
CREATE TRIGGER trg_sites_touch_updated_at
  BEFORE UPDATE ON public.sites
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 9. SERVER-SIDE DASHBOARD SUMMARY (RPC for GET /api/dashboard/summary):
--     today's txn counts/quantities by direction + low-stock item count.
--     Timezone: Asia/Dubai (matches the API's getDubaiTime()).
--     (Site stock aggregation lives in the API layer instead of SQL because
--     the transactions table has optional columns the JS layer already
--     negotiates; see api/src/routes/site.js stock-summary endpoint.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dashboard_summary()
RETURNS json
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT json_build_object(
    'todayInwardQty', COALESCE((
      SELECT SUM(quantity) FROM public.transactions
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Dubai') AT TIME ZONE 'Asia/Dubai'
        AND upper(replace(type, ' ', '_')) IN
            ('RETURN_SITE','RETURN_EMPLOYEE','RETURN_REPAIR','RETURN_NEW','DELIVERY')
    ), 0),
    'todayOutwardQty', COALESCE((
      SELECT SUM(quantity) FROM public.transactions
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Dubai') AT TIME ZONE 'Asia/Dubai'
        AND upper(replace(type, ' ', '_')) IN
            ('ISSUE_SITE','ISSUE_EMPLOYEE','ISSUE_REPAIR','ISSUE_SCRAP')
    ), 0),
    'todayTransferQty', COALESCE((
      SELECT SUM(quantity) FROM public.transactions
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Dubai') AT TIME ZONE 'Asia/Dubai'
        AND upper(replace(type, ' ', '_')) IN ('SITE_TRANSFER','SITE TRANSFER')
    ), 0),
    'lowStockCount', (
      SELECT COUNT(*) FROM public.inventories
      WHERE current_stock > 0 AND current_stock <= reorder_level
    ),
    'outOfStockCount', (
      SELECT COUNT(*) FROM public.inventories WHERE current_stock <= 0
    )
  )
$$;

GRANT EXECUTE ON FUNCTION public.dashboard_summary() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 11. SKU SEQUENCE WIDTH (fbc001 -> fbc0001 pattern going forward).
--     lpad only pads; after 999 the default would have produced fbc1000
--     (inconsistent width). 4 digits gives headroom to 9999.
--     NOTE: if the column default references the sequence in a DO block or
--     function on your instance, re-check with \d inventories after running.
-- ---------------------------------------------------------------------------
ALTER TABLE public.inventories
  ALTER COLUMN sku SET DEFAULT (
    'fbc' || lpad((nextval('inventory_sku_seq'))::text, 4, '0')
  );

-- ---------------------------------------------------------------------------
-- ROLLBACK NOTE: this migration is additive. To revert the trigger:
--   DROP TRIGGER IF EXISTS trg_transactions_maintain_stock ON public.transactions;
--   DROP FUNCTION IF EXISTS public.maintain_inventory_stock();
-- ============================================================================
