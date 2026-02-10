-- ============================================================
-- Fix reinstall cleanup: correct column references, multi-fleet
-- support, shorter delay, and devices table deactivation.
-- ============================================================
-- BUG: cleanup_stale_sos_sessions and cleanup_orphaned_devices
-- used data->>'status' / data->>'last_updated' (JSONB paths)
-- but tracking_sessions has DIRECT columns (status, last_updated).
-- Both functions were completely dead — zero rows ever matched.
-- ============================================================

-- ── 1. Fix cleanup_stale_sos_sessions ──────────────────────
-- Marks SOS sessions as OFFLINE if no GPS update in 30+ minutes
-- (ghost SOS from crashed/deleted apps)

CREATE OR REPLACE FUNCTION public.cleanup_stale_sos_sessions()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  cleaned INTEGER := 0;
BEGIN
  UPDATE public.tracking_sessions
  SET status = 'OFFLINE'
  WHERE status = 'SOS'
    AND last_updated < (now() - interval '30 minutes');

  GET DIAGNOSTICS cleaned = ROW_COUNT;

  IF cleaned > 0 THEN
    RAISE LOG 'cleanup_stale_sos_sessions: marked % stale SOS sessions as OFFLINE', cleaned;
  END IF;

  RETURN cleaned;
END;
$$;

-- ── 2. Fix cleanup_orphaned_devices ────────────────────────
-- Called on login when a user may have reinstalled (new device_id).
-- Now handles ALL user fleets (not just LIMIT 1), uses correct
-- column references, shorter delay (5 min not 24h), and also
-- deactivates old rows in the devices table.

CREATE OR REPLACE FUNCTION public.cleanup_orphaned_devices(p_user_id UUID, p_current_device_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  cleaned INTEGER := 0;
  total_cleaned INTEGER := 0;
  rec RECORD;
BEGIN
  -- Loop through ALL groups the user belongs to
  FOR rec IN
    SELECT group_id FROM public.group_members WHERE user_id = p_user_id
  LOOP
    -- Mark other device_ids in tracking_sessions as OFFLINE
    -- Only if stale (5+ minutes without update) to avoid races with
    -- active family member devices that happen to share the fleet
    UPDATE public.tracking_sessions
    SET status = 'OFFLINE'
    WHERE group_id = rec.group_id
      AND device_id != TRIM(p_current_device_id)
      AND device_id IN (
        SELECT device_id FROM public.devices
        WHERE user_id = p_user_id AND group_id = rec.group_id
          AND device_id != TRIM(p_current_device_id)
      )
      AND status IN ('SOS', 'ACTIVE')
      AND last_updated < (now() - interval '5 minutes');

    GET DIAGNOSTICS cleaned = ROW_COUNT;
    total_cleaned := total_cleaned + cleaned;

    -- Deactivate old device rows in devices table
    UPDATE public.devices
    SET is_active = false
    WHERE user_id = p_user_id
      AND group_id = rec.group_id
      AND device_id != TRIM(p_current_device_id);

  END LOOP;

  IF total_cleaned > 0 THEN
    RAISE LOG 'cleanup_orphaned_devices: marked % orphaned sessions as OFFLINE for user %', total_cleaned, p_user_id;
  END IF;

  RETURN total_cleaned;
END;
$$;

-- ── 3. Enhance register_or_move_device ─────────────────────
-- When a user registers a NEW device_id, deactivate any previous
-- device_ids for the same user+group so we don't accumulate orphans.

CREATE OR REPLACE FUNCTION public.register_or_move_device(
  p_device_id TEXT,
  p_group_id UUID,
  p_display_name TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_is_member BOOLEAN;
  v_is_owner BOOLEAN;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not authenticated');
  END IF;

  IF p_device_id IS NULL OR TRIM(p_device_id) = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid device_id');
  END IF;

  IF p_group_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid group_id');
  END IF;

  -- Check membership
  SELECT EXISTS(
    SELECT 1 FROM public.group_members
    WHERE group_id = p_group_id AND user_id = v_user_id
  ) INTO v_is_member;

  SELECT EXISTS(
    SELECT 1 FROM public.groups
    WHERE id = p_group_id AND owner_user_id = v_user_id
  ) INTO v_is_owner;

  IF NOT v_is_member AND NOT v_is_owner THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not a member of this group');
  END IF;

  -- Deactivate any PREVIOUS device_ids for this user+group
  -- (handles reinstall: old device_id should no longer be active)
  UPDATE public.devices
  SET is_active = false
  WHERE user_id = v_user_id
    AND group_id = p_group_id
    AND device_id != TRIM(p_device_id);

  -- Upsert current device row
  INSERT INTO public.devices (device_id, user_id, group_id, display_name, is_active, last_seen_at)
  VALUES (
    TRIM(p_device_id),
    v_user_id,
    p_group_id,
    COALESCE(NULLIF(TRIM(p_display_name), ''), 'Device'),
    true,
    now()
  )
  ON CONFLICT (device_id) DO UPDATE SET
    user_id = v_user_id,
    group_id = p_group_id,
    display_name = COALESCE(NULLIF(TRIM(p_display_name), ''), devices.display_name, 'Device'),
    is_active = true,
    last_seen_at = now();

  -- Mark old tracking_sessions for this user+group as OFFLINE
  UPDATE public.tracking_sessions
  SET status = 'OFFLINE'
  WHERE device_id IN (
    SELECT device_id FROM public.devices
    WHERE user_id = v_user_id AND group_id = p_group_id
      AND device_id != TRIM(p_device_id) AND is_active = false
  )
  AND status IN ('ACTIVE', 'SOS');

  RETURN jsonb_build_object(
    'ok', true,
    'out_device_id', TRIM(p_device_id),
    'out_group_id', p_group_id,
    'out_user_id', v_user_id
  );
END;
$$;

-- Re-grant permissions (function signatures unchanged)
GRANT EXECUTE ON FUNCTION public.cleanup_stale_sos_sessions() TO service_role;
GRANT EXECUTE ON FUNCTION public.cleanup_orphaned_devices(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_or_move_device(TEXT, UUID, TEXT) TO authenticated;
