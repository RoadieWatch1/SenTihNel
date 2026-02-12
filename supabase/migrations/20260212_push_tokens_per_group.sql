-- ============================================================
-- Push tokens: allow one token per (device_id, group_id) pair
--
-- BUG: push_tokens had a unique constraint on device_id only.
-- When a user switched fleets, the upsert overwrote the group_id,
-- so push notifications for SOS in the old fleet couldn't find
-- the token. Now each fleet gets its own token row.
-- ============================================================

-- 1) Drop the old unique constraint on device_id (name may vary)
ALTER TABLE public.push_tokens
  DROP CONSTRAINT IF EXISTS push_tokens_device_id_key;

-- Also drop any index that might enforce uniqueness on device_id alone
DROP INDEX IF EXISTS public.push_tokens_device_id_key;
DROP INDEX IF EXISTS public.push_tokens_pkey_device_id;

-- 2) Add composite unique constraint on (device_id, group_id)
ALTER TABLE public.push_tokens
  ADD CONSTRAINT push_tokens_device_group_unique UNIQUE (device_id, group_id);
