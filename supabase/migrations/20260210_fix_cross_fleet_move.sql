-- ============================================================
-- Fix cross-fleet device moves: mark old tracking_sessions OFFLINE
-- when a device moves from one fleet to another.
--
-- BUG: register_or_move_device only deactivated old device_ids
-- in the SAME fleet (reinstall case). When a device moved to a
-- DIFFERENT fleet (tab switch, fleet join), the old fleet's
-- tracking_session stayed ACTIVE — showing a stale "ghost" member.
-- ============================================================

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
  v_old_group_id UUID;
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

  -- ✅ FIX: Capture the old group_id BEFORE upserting (for cross-fleet cleanup)
  SELECT group_id INTO v_old_group_id
  FROM public.devices
  WHERE device_id = TRIM(p_device_id);

  -- Deactivate any PREVIOUS device_ids for this user+group (reinstall case)
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

  -- Mark old tracking_sessions for this user+group as OFFLINE (reinstall case)
  UPDATE public.tracking_sessions
  SET status = 'OFFLINE'
  WHERE device_id IN (
    SELECT device_id FROM public.devices
    WHERE user_id = v_user_id AND group_id = p_group_id
      AND device_id != TRIM(p_device_id) AND is_active = false
  )
  AND status IN ('ACTIVE', 'SOS');

  -- ✅ FIX: If device moved to a DIFFERENT fleet, mark old fleet's tracking_session as OFFLINE
  IF v_old_group_id IS NOT NULL AND v_old_group_id != p_group_id THEN
    UPDATE public.tracking_sessions
    SET status = 'OFFLINE'
    WHERE device_id = TRIM(p_device_id)
      AND group_id = v_old_group_id
      AND status IN ('ACTIVE', 'SOS');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'out_device_id', TRIM(p_device_id),
    'out_group_id', p_group_id,
    'out_user_id', v_user_id
  );
END;
$$;

-- Re-grant permissions
GRANT EXECUTE ON FUNCTION public.register_or_move_device(TEXT, UUID, TEXT) TO authenticated;
