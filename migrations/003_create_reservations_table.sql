-- ===========================================================================
-- Migration 003: Create 'reservations' table for site stock holds
-- ===========================================================================
-- Stores item reservations made for sites (holds on warehouse inventory)
-- until approved and issued to the site from the Site Details screen.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id text NOT NULL,
  item_id uuid NOT NULL REFERENCES public.inventories(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES public.sites(id) ON DELETE CASCADE,
  quantity numeric NOT NULL DEFAULT 1,
  reserved_by text,
  notes text,
  status text NOT NULL DEFAULT 'ACTIVE',
  fulfilled_txn_id text,
  fulfilled_at timestamptz,
  cancel_reason text,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reservations_quantity_positive CHECK (quantity > 0)
);

CREATE INDEX IF NOT EXISTS idx_reservations_site_status
  ON public.reservations (site_id, status);

CREATE INDEX IF NOT EXISTS idx_reservations_item_status
  ON public.reservations (item_id, status);

CREATE INDEX IF NOT EXISTS idx_reservations_created_at
  ON public.reservations (created_at DESC);

-- Enable RLS and grant policy so both API and users can read/write reservations
ALTER TABLE public.reservations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'reservations' AND policyname = 'Allow all access to reservations'
  ) THEN
    CREATE POLICY "Allow all access to reservations"
      ON public.reservations
      FOR ALL
      TO authenticated, anon
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;
