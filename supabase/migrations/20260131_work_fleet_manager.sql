-- supabase/migrations/20260131_work_fleet_manager.sql
-- Work Fleet Manager Dashboard: Owner can track all fleet members
-- ============================================

-- ============================================
-- 1. FUNCTION: Get all Work fleet members' locations (owner only)
-- ============================================
CREATE OR REPLACE FUNCTION public.get_work_fleet_members_locations()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_group_id UUID;
  v_is_owner BOOLEAN;
  v_members JSONB;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Get the user's Work fleet membership
  SELECT gm.group_id INTO v_group_id
  FROM public.group_members gm
  WHERE gm.user_id = v_user_id AND gm.fleet_type = 'work'
  LIMIT 1;

  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'You are not in a Work fleet');
  END IF;

  -- Check if user is the owner of this fleet
  SELECT (g.owner_user_id = v_user_id) INTO v_is_owner
  FROM public.groups g
  WHERE g.id = v_group_id;

  IF NOT v_is_owner THEN
    RETURN jsonb_build_object('success', false, 'error', 'Only fleet owner can view member locations');
  END IF;

  -- Get all members with their latest tracking data
  SELECT jsonb_agg(
    jsonb_build_object(
      'user_id', gm.user_id,
      'device_id', ts.device_id,
      'display_name', COALESCE(p.display_name, 'Member'),
      'latitude', ts.latitude,
      'longitude', ts.longitude,
      'status', ts.status,
      'battery_level', ts.battery_level,
      'gps_accuracy_m', ts.gps_accuracy_m,
      'last_updated', ts.last_updated,
      'joined_at', gm.created_at
    )
  ) INTO v_members
  FROM public.group_members gm
  LEFT JOIN public.profiles p ON p.id = gm.user_id
  LEFT JOIN public.tracking_sessions ts ON ts.group_id = v_group_id
    AND ts.device_id = (
      SELECT db.device_id FROM public.device_bindings db
      WHERE db.user_id = gm.user_id AND db.group_id = v_group_id
      LIMIT 1
    )
  WHERE gm.group_id = v_group_id AND gm.fleet_type = 'work';

  RETURN jsonb_build_object(
    'success', true,
    'group_id', v_group_id,
    'members', COALESCE(v_members, '[]'::jsonb),
    'member_count', jsonb_array_length(COALESCE(v_members, '[]'::jsonb))
  );
END;
$$;

-- ============================================
-- 2. FUNCTION: Check if user is Work fleet owner
-- ============================================
CREATE OR REPLACE FUNCTION public.is_work_fleet_owner()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_group_id UUID;
  v_is_owner BOOLEAN;
  v_invite_code TEXT;
  v_member_count INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('is_owner', false, 'error', 'Not authenticated');
  END IF;

  -- Get the user's Work fleet membership
  SELECT gm.group_id INTO v_group_id
  FROM public.group_members gm
  WHERE gm.user_id = v_user_id AND gm.fleet_type = 'work'
  LIMIT 1;

  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('is_owner', false, 'has_work_fleet', false);
  END IF;

  -- Check if user is the owner
  SELECT (g.owner_user_id = v_user_id), g.invite_code INTO v_is_owner, v_invite_code
  FROM public.groups g
  WHERE g.id = v_group_id;

  -- Count members
  SELECT COUNT(*) INTO v_member_count
  FROM public.group_members
  WHERE group_id = v_group_id;

  RETURN jsonb_build_object(
    'is_owner', COALESCE(v_is_owner, false),
    'has_work_fleet', true,
    'group_id', v_group_id,
    'invite_code', v_invite_code,
    'member_count', v_member_count
  );
END;
$$;

-- ============================================
-- DONE
-- ============================================
