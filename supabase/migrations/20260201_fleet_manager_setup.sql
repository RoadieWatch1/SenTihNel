-- ============================================
-- FLEET MANAGER AUTO-SETUP MIGRATION
-- ============================================
-- This migration:
-- 1. Adds fleet_type column to groups table
-- 2. Creates ensure_user_fleets() RPC to auto-create both Work and Family fleets
-- 3. Creates get_user_owned_fleets() RPC to fetch user's owned fleets
-- ============================================

-- ============================================
-- 1. ADD fleet_type COLUMN TO GROUPS
-- ============================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'groups' AND column_name = 'fleet_type'
  ) THEN
    ALTER TABLE public.groups ADD COLUMN fleet_type TEXT DEFAULT 'family';
  END IF;
END $$;

-- Add constraint for valid fleet types
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'groups_fleet_type_check'
  ) THEN
    ALTER TABLE public.groups ADD CONSTRAINT groups_fleet_type_check
      CHECK (fleet_type IN ('work', 'family'));
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- Add index for faster lookups by owner and fleet_type
CREATE INDEX IF NOT EXISTS idx_groups_owner_fleet_type ON public.groups(owner_user_id, fleet_type);

-- ============================================
-- 2. ENSURE_USER_FLEETS RPC
-- Auto-creates both Work and Family fleets for a user
-- Called on login/signup
-- ============================================
CREATE OR REPLACE FUNCTION public.ensure_user_fleets()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_work_group_id UUID;
  v_family_group_id UUID;
  v_work_invite_code TEXT;
  v_family_invite_code TEXT;
  v_work_exists BOOLEAN := false;
  v_family_exists BOOLEAN := false;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Check if user already has a Work fleet they own
  SELECT id, invite_code INTO v_work_group_id, v_work_invite_code
  FROM public.groups
  WHERE owner_user_id = v_user_id AND fleet_type = 'work'
  LIMIT 1;

  IF v_work_group_id IS NOT NULL THEN
    v_work_exists := true;
  ELSE
    -- Generate unique invite code for Work fleet
    LOOP
      v_work_invite_code := 'W-' || UPPER(SUBSTRING(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT) FROM 1 FOR 6));
      IF NOT EXISTS (SELECT 1 FROM public.groups WHERE invite_code = v_work_invite_code) THEN EXIT; END IF;
    END LOOP;

    -- Create Work fleet
    INSERT INTO public.groups (owner_user_id, invite_code, fleet_type)
    VALUES (v_user_id, v_work_invite_code, 'work')
    RETURNING id INTO v_work_group_id;

    -- Auto-add user as member of their own Work fleet
    INSERT INTO public.group_members (user_id, group_id, fleet_type)
    VALUES (v_user_id, v_work_group_id, 'work')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Check if user already has a Family fleet they own
  SELECT id, invite_code INTO v_family_group_id, v_family_invite_code
  FROM public.groups
  WHERE owner_user_id = v_user_id AND fleet_type = 'family'
  LIMIT 1;

  IF v_family_group_id IS NOT NULL THEN
    v_family_exists := true;
  ELSE
    -- Generate unique invite code for Family fleet
    LOOP
      v_family_invite_code := 'F-' || UPPER(SUBSTRING(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT) FROM 1 FOR 6));
      IF NOT EXISTS (SELECT 1 FROM public.groups WHERE invite_code = v_family_invite_code) THEN EXIT; END IF;
    END LOOP;

    -- Create Family fleet
    INSERT INTO public.groups (owner_user_id, invite_code, fleet_type)
    VALUES (v_user_id, v_family_invite_code, 'family')
    RETURNING id INTO v_family_group_id;

    -- Auto-add user as member of their own Family fleet
    INSERT INTO public.group_members (user_id, group_id, fleet_type)
    VALUES (v_user_id, v_family_group_id, 'family')
    ON CONFLICT DO NOTHING;
  END IF;

  -- Ensure user is a member of their OWN fleets
  -- Only add if they're not already a member of ANY fleet of that type
  -- (This preserves membership in other users' fleets)
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE user_id = v_user_id AND fleet_type = 'work'
  ) THEN
    INSERT INTO public.group_members (user_id, group_id, fleet_type)
    VALUES (v_user_id, v_work_group_id, 'work');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE user_id = v_user_id AND fleet_type = 'family'
  ) THEN
    INSERT INTO public.group_members (user_id, group_id, fleet_type)
    VALUES (v_user_id, v_family_group_id, 'family');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'work_fleet', jsonb_build_object(
      'group_id', v_work_group_id,
      'invite_code', v_work_invite_code,
      'already_existed', v_work_exists
    ),
    'family_fleet', jsonb_build_object(
      'group_id', v_family_group_id,
      'invite_code', v_family_invite_code,
      'already_existed', v_family_exists
    )
  );
END;
$$;

-- ============================================
-- 3. GET_USER_OWNED_FLEETS RPC
-- Returns both Work and Family fleets the user owns with member counts
-- ============================================
CREATE OR REPLACE FUNCTION public.get_user_owned_fleets()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_result JSONB;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  SELECT jsonb_build_object(
    'success', true,
    'fleets', COALESCE(jsonb_agg(
      jsonb_build_object(
        'group_id', g.id,
        'fleet_type', g.fleet_type,
        'invite_code', g.invite_code,
        'member_count', (
          SELECT COUNT(*) FROM public.group_members gm WHERE gm.group_id = g.id
        ),
        'is_owner', true
      )
    ), '[]'::jsonb)
  ) INTO v_result
  FROM public.groups g
  WHERE g.owner_user_id = v_user_id;

  RETURN v_result;
END;
$$;

-- ============================================
-- 4. GET_FLEET_MEMBERS RPC
-- Returns members of a specific fleet (must be owner or member)
-- ============================================
CREATE OR REPLACE FUNCTION public.get_fleet_members(p_group_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_is_member BOOLEAN;
  v_result JSONB;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Check if user is a member of this fleet
  SELECT EXISTS(
    SELECT 1 FROM public.group_members
    WHERE group_id = p_group_id AND user_id = v_user_id
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not a member of this fleet');
  END IF;

  -- Get members with their device info
  SELECT jsonb_build_object(
    'success', true,
    'members', COALESCE(jsonb_agg(
      jsonb_build_object(
        'user_id', gm.user_id,
        'fleet_type', gm.fleet_type,
        'joined_at', gm.created_at,
        'is_owner', (g.owner_user_id = gm.user_id)
      )
    ), '[]'::jsonb)
  ) INTO v_result
  FROM public.group_members gm
  JOIN public.groups g ON g.id = gm.group_id
  WHERE gm.group_id = p_group_id;

  RETURN v_result;
END;
$$;

-- ============================================
-- 5. UPDATE create_group_and_join to set fleet_type
-- ============================================
CREATE OR REPLACE FUNCTION public.create_group_and_join(p_fleet_type TEXT DEFAULT 'family')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_group_id UUID;
  v_invite_code TEXT;
  v_fleet_type TEXT;
  v_prefix TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  v_fleet_type := LOWER(COALESCE(p_fleet_type, 'family'));
  IF v_fleet_type NOT IN ('work', 'family') THEN
    v_fleet_type := 'family';
  END IF;

  -- Check if user already owns a fleet of this type
  SELECT id, invite_code INTO v_group_id, v_invite_code
  FROM public.groups
  WHERE owner_user_id = v_user_id AND fleet_type = v_fleet_type
  LIMIT 1;

  IF v_group_id IS NOT NULL THEN
    -- Already has a fleet of this type, return it
    RETURN jsonb_build_object(
      'success', true,
      'group_id', v_group_id,
      'invite_code', v_invite_code,
      'fleet_type', v_fleet_type,
      'already_existed', true
    );
  END IF;

  -- Generate prefix based on fleet type
  v_prefix := CASE WHEN v_fleet_type = 'work' THEN 'W-' ELSE 'F-' END;

  -- Generate unique invite code
  LOOP
    v_invite_code := v_prefix || UPPER(SUBSTRING(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT) FROM 1 FOR 6));
    IF NOT EXISTS (SELECT 1 FROM public.groups WHERE invite_code = v_invite_code) THEN EXIT; END IF;
  END LOOP;

  -- Create the group with fleet_type
  INSERT INTO public.groups (owner_user_id, invite_code, fleet_type)
  VALUES (v_user_id, v_invite_code, v_fleet_type)
  RETURNING id INTO v_group_id;

  -- Add user as member
  INSERT INTO public.group_members (user_id, group_id, fleet_type)
  VALUES (v_user_id, v_group_id, v_fleet_type);

  RETURN jsonb_build_object(
    'success', true,
    'group_id', v_group_id,
    'invite_code', v_invite_code,
    'fleet_type', v_fleet_type,
    'already_existed', false
  );
END;
$$;

-- ============================================
-- 6. UPDATED register_or_move_device RPC
-- Now allows fleet OWNERS (not just members) to register devices
-- ============================================
DROP FUNCTION IF EXISTS public.register_or_move_device(TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.register_or_move_device(TEXT, UUID);

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
  v_existing_device_id TEXT;
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

  -- Check if user is a MEMBER of this group
  SELECT EXISTS(
    SELECT 1 FROM public.group_members
    WHERE group_id = p_group_id AND user_id = v_user_id
  ) INTO v_is_member;

  -- ✅ Also check if user OWNS this group (can register even if not a "member")
  SELECT EXISTS(
    SELECT 1 FROM public.groups
    WHERE id = p_group_id AND owner_user_id = v_user_id
  ) INTO v_is_owner;

  IF NOT v_is_member AND NOT v_is_owner THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not a member of this group');
  END IF;

  -- Upsert device row
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

  RETURN jsonb_build_object(
    'ok', true,
    'out_device_id', TRIM(p_device_id),
    'out_group_id', p_group_id,
    'out_user_id', v_user_id
  );
END;
$$;

-- ============================================
-- 7. UPDATED claim_tracking_session_device RPC
-- Now allows fleet OWNERS (not just members) to claim tracking sessions
-- ============================================
DROP FUNCTION IF EXISTS public.claim_tracking_session_device(TEXT, UUID);

CREATE OR REPLACE FUNCTION public.claim_tracking_session_device(
  p_device_id TEXT,
  p_group_id UUID
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

  -- Check if user is a MEMBER of this group
  SELECT EXISTS(
    SELECT 1 FROM public.group_members
    WHERE group_id = p_group_id AND user_id = v_user_id
  ) INTO v_is_member;

  -- ✅ Also check if user OWNS this group
  SELECT EXISTS(
    SELECT 1 FROM public.groups
    WHERE id = p_group_id AND owner_user_id = v_user_id
  ) INTO v_is_owner;

  IF NOT v_is_member AND NOT v_is_owner THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not a member of destination group');
  END IF;

  -- Update tracking_sessions to new group_id
  UPDATE public.tracking_sessions
  SET group_id = p_group_id
  WHERE device_id = TRIM(p_device_id);

  -- If no rows updated, insert a new one
  IF NOT FOUND THEN
    INSERT INTO public.tracking_sessions (device_id, group_id, status, last_updated)
    VALUES (TRIM(p_device_id), p_group_id, 'ACTIVE', now())
    ON CONFLICT (device_id) DO UPDATE SET
      group_id = p_group_id,
      last_updated = now();
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================
-- 8. UPDATE RLS POLICIES FOR tracking_sessions
-- Allow fleet OWNERS (not just members) to insert/update tracking sessions
-- ============================================

-- First, drop ALL existing policies on tracking_sessions (find and drop dynamically)
DO $$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE tablename = 'tracking_sessions' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.tracking_sessions', pol.policyname);
  END LOOP;
END $$;

-- Create new policies that include OWNERS
CREATE POLICY "Owners and members can insert tracking"
ON public.tracking_sessions FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = tracking_sessions.group_id AND gm.user_id = auth.uid()
  )
  OR
  EXISTS (
    SELECT 1 FROM public.groups g
    WHERE g.id = tracking_sessions.group_id AND g.owner_user_id = auth.uid()
  )
);

CREATE POLICY "Owners and members can update tracking"
ON public.tracking_sessions FOR UPDATE
USING (
  EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = tracking_sessions.group_id AND gm.user_id = auth.uid()
  )
  OR
  EXISTS (
    SELECT 1 FROM public.groups g
    WHERE g.id = tracking_sessions.group_id AND g.owner_user_id = auth.uid()
  )
);

CREATE POLICY "Owners and members can view tracking"
ON public.tracking_sessions FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = tracking_sessions.group_id AND gm.user_id = auth.uid()
  )
  OR
  EXISTS (
    SELECT 1 FROM public.groups g
    WHERE g.id = tracking_sessions.group_id AND g.owner_user_id = auth.uid()
  )
);

-- ============================================
-- 9. UPSERT TRACKING SESSION RPC (bypasses RLS entirely)
-- Use this for ALL tracking updates instead of direct upserts
-- ============================================
DROP FUNCTION IF EXISTS public.upsert_tracking_session(TEXT, UUID, JSONB);

CREATE OR REPLACE FUNCTION public.upsert_tracking_session(
  p_device_id TEXT,
  p_group_id UUID,
  p_data JSONB DEFAULT '{}'::JSONB
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

  -- Check if user is a MEMBER of this group
  SELECT EXISTS(
    SELECT 1 FROM public.group_members
    WHERE group_id = p_group_id AND user_id = v_user_id
  ) INTO v_is_member;

  -- Also check if user OWNS this group
  SELECT EXISTS(
    SELECT 1 FROM public.groups
    WHERE id = p_group_id AND owner_user_id = v_user_id
  ) INTO v_is_owner;

  IF NOT v_is_member AND NOT v_is_owner THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not authorized for this fleet');
  END IF;

  -- Upsert tracking session with all provided data
  INSERT INTO public.tracking_sessions (
    device_id,
    group_id,
    latitude,
    longitude,
    battery_level,
    status,
    last_updated,
    gps_quality,
    gps_accuracy_m,
    speed,
    heading
  )
  VALUES (
    TRIM(p_device_id),
    p_group_id,
    (p_data->>'latitude')::DOUBLE PRECISION,
    (p_data->>'longitude')::DOUBLE PRECISION,
    COALESCE((p_data->>'battery_level')::INTEGER, -1),
    COALESCE(p_data->>'status', 'ACTIVE'),
    COALESCE((p_data->>'last_updated')::TIMESTAMPTZ, now()),
    p_data->>'gps_quality',
    (p_data->>'gps_accuracy_m')::INTEGER,
    (p_data->>'speed')::DOUBLE PRECISION,
    (p_data->>'heading')::DOUBLE PRECISION
  )
  ON CONFLICT (device_id) DO UPDATE SET
    group_id = p_group_id,
    latitude = COALESCE((p_data->>'latitude')::DOUBLE PRECISION, tracking_sessions.latitude),
    longitude = COALESCE((p_data->>'longitude')::DOUBLE PRECISION, tracking_sessions.longitude),
    battery_level = COALESCE((p_data->>'battery_level')::INTEGER, tracking_sessions.battery_level),
    status = COALESCE(p_data->>'status', tracking_sessions.status),
    last_updated = COALESCE((p_data->>'last_updated')::TIMESTAMPTZ, now()),
    gps_quality = COALESCE(p_data->>'gps_quality', tracking_sessions.gps_quality),
    gps_accuracy_m = COALESCE((p_data->>'gps_accuracy_m')::INTEGER, tracking_sessions.gps_accuracy_m),
    speed = COALESCE((p_data->>'speed')::DOUBLE PRECISION, tracking_sessions.speed),
    heading = COALESCE((p_data->>'heading')::DOUBLE PRECISION, tracking_sessions.heading);

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ============================================
-- 10. GRANT PERMISSIONS
-- ============================================
GRANT EXECUTE ON FUNCTION public.ensure_user_fleets() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_owned_fleets() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_fleet_members(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_group_and_join(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_or_move_device(TEXT, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_tracking_session_device(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_tracking_session(TEXT, UUID, JSONB) TO authenticated;

-- ============================================
-- 11. FIX: join_group_with_invite_code - Allow fleet owners without subscription
-- ============================================
CREATE OR REPLACE FUNCTION public.join_group_with_invite_code(
  p_invite_code TEXT,
  p_fleet_type TEXT DEFAULT 'family'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_group_id UUID;
  v_normalized_code TEXT;
  v_existing_membership UUID;
  v_fleet_type TEXT;
  v_is_blocked BOOLEAN;
  v_has_sub BOOLEAN;
  v_is_enterprise_covered BOOLEAN;
  v_is_owner BOOLEAN;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  v_fleet_type := LOWER(COALESCE(p_fleet_type, 'family'));
  IF v_fleet_type NOT IN ('work', 'family') THEN
    v_fleet_type := 'family';
  END IF;

  -- Normalize invite code
  v_normalized_code := UPPER(REGEXP_REPLACE(TRIM(p_invite_code), '[^A-Z0-9]', '', 'g'));
  IF v_normalized_code = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid invite code');
  END IF;

  -- Find the group
  SELECT id INTO v_group_id FROM public.groups
  WHERE UPPER(REGEXP_REPLACE(invite_code, '[^A-Z0-9]', '', 'g')) = v_normalized_code LIMIT 1;

  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invite code not found');
  END IF;

  -- ✅ Check if user OWNS this fleet (no subscription needed for own fleets)
  SELECT EXISTS(
    SELECT 1 FROM public.groups
    WHERE id = v_group_id AND owner_user_id = v_user_id
  ) INTO v_is_owner;

  -- Only check subscription if NOT the owner
  IF NOT v_is_owner THEN
    -- Check if user has active subscription
    SELECT EXISTS(
      SELECT 1 FROM public.subscriptions
      WHERE user_id = v_user_id
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > now())
    ) INTO v_has_sub;

    -- Check if covered by enterprise
    SELECT EXISTS(
      SELECT 1 FROM public.enterprise_members em
      JOIN public.enterprise_codes ec ON ec.id = em.enterprise_code_id
      JOIN public.subscriptions s ON s.id = ec.subscription_id
      WHERE em.user_id = v_user_id
        AND ec.is_active = true
        AND s.status = 'active'
        AND (ec.expires_at IS NULL OR ec.expires_at > now())
    ) INTO v_is_enterprise_covered;

    -- Must have subscription or enterprise coverage to join someone else's fleet
    IF NOT v_has_sub AND NOT v_is_enterprise_covered THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Subscription required to join a fleet',
        'debug', jsonb_build_object(
          'has_subscription', v_has_sub,
          'is_enterprise_covered', v_is_enterprise_covered,
          'is_owner', v_is_owner
        )
      );
    END IF;
  END IF;

  -- Check if user is blocked from this fleet
  SELECT EXISTS(
    SELECT 1 FROM public.fleet_blocked_users
    WHERE group_id = v_group_id AND blocked_user_id = v_user_id
  ) INTO v_is_blocked;

  IF v_is_blocked THEN
    RETURN jsonb_build_object('success', false, 'error', 'You have been blocked from this fleet');
  END IF;

  -- Remove existing fleet of same type
  DELETE FROM public.group_members WHERE user_id = v_user_id AND fleet_type = v_fleet_type;

  -- Check if already in this specific group (with different fleet_type)
  SELECT id INTO v_existing_membership
  FROM public.group_members WHERE user_id = v_user_id AND group_id = v_group_id LIMIT 1;

  IF v_existing_membership IS NOT NULL THEN
    UPDATE public.group_members SET fleet_type = v_fleet_type WHERE id = v_existing_membership;
    RETURN jsonb_build_object('success', true, 'group_id', v_group_id, 'fleet_type', v_fleet_type, 'action', 'updated', 'is_owner', v_is_owner);
  END IF;

  INSERT INTO public.group_members (user_id, group_id, fleet_type) VALUES (v_user_id, v_group_id, v_fleet_type);
  RETURN jsonb_build_object('success', true, 'group_id', v_group_id, 'fleet_type', v_fleet_type, 'action', 'joined', 'is_owner', v_is_owner);
END;
$$;

GRANT EXECUTE ON FUNCTION public.join_group_with_invite_code(TEXT, TEXT) TO authenticated;
