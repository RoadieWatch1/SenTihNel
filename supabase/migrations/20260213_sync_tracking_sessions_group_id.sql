-- Migration: Sync tracking_sessions.group_id with devices.group_id
-- Date: 2026-02-13
-- Purpose:
-- 1) Mark any ACTIVE/SOS tracking_sessions that still reference an old group_id as OFFLINE
--    to avoid showing ghost users in the wrong fleet.
-- 2) Align tracking_sessions.group_id to the authoritative devices.group_id.

BEGIN;

-- 1) Mark old/incorrect active sessions OFFLINE
UPDATE public.tracking_sessions ts
SET status = 'OFFLINE'
FROM public.devices d
WHERE ts.device_id = d.device_id
  AND ts.group_id IS NOT NULL
  AND ts.group_id <> d.group_id
  AND ts.status IN ('ACTIVE', 'SOS');

-- 2) Align tracking_sessions.group_id to the authoritative devices.group_id
UPDATE public.tracking_sessions ts
SET group_id = d.group_id
FROM public.devices d
WHERE ts.device_id = d.device_id
  AND (ts.group_id IS DISTINCT FROM d.group_id OR ts.group_id IS NULL);

COMMIT;
