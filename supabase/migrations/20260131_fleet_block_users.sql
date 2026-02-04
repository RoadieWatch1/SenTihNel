-- supabase/migrations/20260131_fleet_block_users.sql
-- Fleet managers can block users from joining their fleet
-- ============================================

-- ============================================
-- 1. TABLE: Blocked users per fleet
-- ============================================
CREATE TABLE IF NOT EXISTS public.fleet_blocked_users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  blocked_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT unique_blocked_user_per_fleet UNIQUE (group_id, blocked_user_id)
);

CREATE INDEX IF NOT EXISTS idx_fleet_blocked_users_group ON public.fleet_blocked_users(group_id);
CREATE INDEX IF NOT EXISTS idx_fleet_blocked_users_user ON public.fleet_blocked_users(blocked_user_id);

ALTER TABLE public.fleet_blocked_users ENABLE ROW LEVEL SECURITY;

-- Only fleet owner can view blocked users
DROP POLICY IF EXISTS "Fleet owner can view blocked users" ON public.fleet_blocked_users;
CREATE POLICY "Fleet owner can view blocked users"
ON public.fleet_blocked_users FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.groups g
    WHERE g.id = group_id AND g.owner_user_id = auth.uid()
  )
);

-- ============================================
-- 2. FUNCTION: Block a user from fleet (owner only)
-- ============================================
CREATE OR REPLACE FUNCTION public.block_user_from_fleet(
  p_user_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_owner_id UUID;
  v_group_id UUID;
BEGIN
  v_owner_id := auth.uid();
  IF v_owner_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Cannot block yourself
  IF p_user_id = v_owner_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'Cannot block yourself');
  END IF;

  -- Get the owner's Work fleet
  SELECT gm.group_id INTO v_group_id
  FROM public.group_members gm
  JOIN public.groups g ON g.id = gm.group_id
  WHERE gm.user_id = v_owner_id
    AND gm.fleet_type = 'work'
    AND g.owner_user_id = v_owner_id
  LIMIT 1;

  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'You must own a Work fleet to block users');
  END IF;

  -- Remove user from fleet if currently a member
  DELETE FROM public.group_members
  WHERE user_id = p_user_id AND group_id = v_group_id;

  -- Add to blocked list (upsert)
  INSERT INTO public.fleet_blocked_users (group_id, blocked_user_id, blocked_by, reason)
  VALUES (v_group_id, p_user_id, v_owner_id, p_reason)
  ON CONFLICT (group_id, blocked_user_id)
  DO UPDATE SET reason = EXCLUDED.reason, created_at = now();

  RETURN jsonb_build_object('success', true, 'user_id', p_user_id);
END;
$$;

-- ============================================
-- 3. FUNCTION: Unblock a user (owner only)
-- ============================================
CREATE OR REPLACE FUNCTION public.unblock_user_from_fleet(p_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_owner_id UUID;
  v_group_id UUID;
  v_deleted INTEGER;
BEGIN
  v_owner_id := auth.uid();
  IF v_owner_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Get the owner's Work fleet
  SELECT gm.group_id INTO v_group_id
  FROM public.group_members gm
  JOIN public.groups g ON g.id = gm.group_id
  WHERE gm.user_id = v_owner_id
    AND gm.fleet_type = 'work'
    AND g.owner_user_id = v_owner_id
  LIMIT 1;

  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No Work fleet found');
  END IF;

  DELETE FROM public.fleet_blocked_users
  WHERE group_id = v_group_id AND blocked_user_id = p_user_id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted > 0 THEN
    RETURN jsonb_build_object('success', true, 'user_id', p_user_id);
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'User was not blocked');
  END IF;
END;
$$;

-- ============================================
-- 4. FUNCTION: Get blocked users list (owner only)
-- ============================================
CREATE OR REPLACE FUNCTION public.get_blocked_users()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_owner_id UUID;
  v_group_id UUID;
  v_blocked JSONB;
BEGIN
  v_owner_id := auth.uid();
  IF v_owner_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Get the owner's Work fleet
  SELECT gm.group_id INTO v_group_id
  FROM public.group_members gm
  JOIN public.groups g ON g.id = gm.group_id
  WHERE gm.user_id = v_owner_id
    AND gm.fleet_type = 'work'
    AND g.owner_user_id = v_owner_id
  LIMIT 1;

  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No Work fleet found');
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'user_id', fbu.blocked_user_id,
      'display_name', COALESCE(p.display_name, 'Unknown'),
      'reason', fbu.reason,
      'blocked_at', fbu.created_at
    )
  ) INTO v_blocked
  FROM public.fleet_blocked_users fbu
  LEFT JOIN public.profiles p ON p.id = fbu.blocked_user_id
  WHERE fbu.group_id = v_group_id;

  RETURN jsonb_build_object('success', true, 'blocked_users', COALESCE(v_blocked, '[]'::jsonb));
END;
$$;

-- ============================================
-- 5. UPDATE: join_group_with_invite_code to check blocklist
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
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  v_fleet_type := LOWER(COALESCE(p_fleet_type, 'family'));
  IF v_fleet_type NOT IN ('work', 'family') THEN
    v_fleet_type := 'family';
  END IF;

  v_normalized_code := UPPER(REGEXP_REPLACE(TRIM(p_invite_code), '[^A-Z0-9]', '', 'g'));
  IF v_normalized_code = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid invite code');
  END IF;

  SELECT id INTO v_group_id FROM public.groups
  WHERE UPPER(REGEXP_REPLACE(invite_code, '[^A-Z0-9]', '', 'g')) = v_normalized_code LIMIT 1;

  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invite code not found');
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
    RETURN jsonb_build_object('success', true, 'group_id', v_group_id, 'fleet_type', v_fleet_type, 'action', 'updated');
  END IF;

  INSERT INTO public.group_members (user_id, group_id, fleet_type) VALUES (v_user_id, v_group_id, v_fleet_type);
  RETURN jsonb_build_object('success', true, 'group_id', v_group_id, 'fleet_type', v_fleet_type, 'action', 'joined');
END;
$$;

-- ============================================
-- DONE
-- ============================================
