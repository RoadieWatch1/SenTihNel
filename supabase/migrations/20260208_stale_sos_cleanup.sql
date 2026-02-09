-- ============================================================
-- Stale SOS Cleanup: Auto-mark orphaned SOS sessions as OFFLINE
-- ============================================================
-- If a device is stuck in SOS status but hasn't sent a GPS update
-- in 30+ minutes, it's almost certainly dead/uninstalled/crashed.
-- This function marks those sessions OFFLINE so fleet members
-- don't see a permanent ghost SOS.
--
-- Should be called by a Supabase cron job (pg_cron) every 10 minutes.

CREATE OR REPLACE FUNCTION public.cleanup_stale_sos_sessions()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  cleaned INTEGER := 0;
BEGIN
  UPDATE public.tracking_sessions
  SET data = jsonb_set(
    COALESCE(data, '{}'::jsonb),
    '{status}',
    '"OFFLINE"'::jsonb
  )
  WHERE (data->>'status') = 'SOS'
    AND (data->>'last_updated')::timestamptz < (now() - interval '30 minutes');

  GET DIAGNOSTICS cleaned = ROW_COUNT;

  IF cleaned > 0 THEN
    RAISE LOG 'cleanup_stale_sos_sessions: marked % stale SOS sessions as OFFLINE', cleaned;
  END IF;

  RETURN cleaned;
END;
$$;

-- Grant execute to service_role (for cron job)
GRANT EXECUTE ON FUNCTION public.cleanup_stale_sos_sessions() TO service_role;

-- ============================================================
-- Orphaned device cleanup: Mark old device_ids OFFLINE for a user
-- Called on login when a user may have reinstalled (new device_id)
-- ============================================================
CREATE OR REPLACE FUNCTION public.cleanup_orphaned_devices(p_user_id UUID, p_current_device_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  cleaned INTEGER := 0;
  user_group_id BIGINT;
BEGIN
  -- Find user's group
  SELECT group_id INTO user_group_id
  FROM public.group_members
  WHERE user_id = p_user_id
  LIMIT 1;

  IF user_group_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Mark all OTHER device_ids for this group as OFFLINE
  -- (the user's old devices from before reinstall)
  UPDATE public.tracking_sessions
  SET data = jsonb_set(
    COALESCE(data, '{}'::jsonb),
    '{status}',
    '"OFFLINE"'::jsonb
  )
  WHERE group_id = user_group_id
    AND device_id != p_current_device_id
    AND (data->>'status') IN ('SOS', 'ACTIVE')
    AND (data->>'last_updated')::timestamptz < (now() - interval '24 hours');

  GET DIAGNOSTICS cleaned = ROW_COUNT;

  RETURN cleaned;
END;
$$;

-- Grant to authenticated users (called from app on login)
GRANT EXECUTE ON FUNCTION public.cleanup_orphaned_devices(UUID, TEXT) TO authenticated;

-- ============================================================
-- Schedule cron job (if pg_cron is available)
-- Runs every 10 minutes to clean up stale SOS sessions
-- ============================================================
-- NOTE: pg_cron must be enabled in your Supabase project settings.
-- If pg_cron is not available, the cleanup_stale_sos_sessions function
-- can be called manually or via an Edge Function on a schedule.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'cleanup-stale-sos',
      '*/10 * * * *',
      'SELECT public.cleanup_stale_sos_sessions()'
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'pg_cron not available — schedule cleanup_stale_sos_sessions manually';
END;
$$;
