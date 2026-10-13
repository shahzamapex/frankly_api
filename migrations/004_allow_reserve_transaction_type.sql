-- ===========================================================================
-- Migration 004: Allow 'RESERVE' transaction type in check constraint
-- ===========================================================================
-- The previous constraint transactions_type_allowed restricted types to
-- issue/return/transfer/delivery/adjust variants. This migration updates the check
-- constraint to include 'RESERVE' for item reservations.
-- ===========================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_type_allowed'
  ) THEN
    ALTER TABLE public.transactions DROP CONSTRAINT transactions_type_allowed;
  END IF;

  ALTER TABLE public.transactions
    ADD CONSTRAINT transactions_type_allowed CHECK (
      type IN (
        'ISSUE_SITE', 'ISSUE_EMPLOYEE', 'ISSUE_REPAIR', 'ISSUE_SCRAP',
        'RETURN_SITE', 'RETURN_EMPLOYEE', 'RETURN_REPAIR', 'RETURN_NEW',
        'SITE TRANSFER', 'SITE_TRANSFER', 'DELIVERY',
        'ISSUE', 'RETURN', 'NEW', 'RECEIVE', 'INWARD',
        'ADJUST', 'RESERVE'
      )
    ) NOT VALID;

  RAISE NOTICE 'transactions_type_allowed updated to include RESERVE';
END
$$;
