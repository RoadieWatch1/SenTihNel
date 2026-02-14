-- ============================================================
-- MIGRATION: Missing RPCs + RLS for devices/groups/group_members
-- Date: 2026-02-13
-- Run each section independently in Supabase SQL Editor.
-- ============================================================


-- ============================================================
-- SECTION 1: get_group_id_by_invite_code RPC
-- ============================================================
-- Client calls this from fleet.js and auth.js to resolve
-- an invite code to a group_id before joining.
-- Uses same normalization as join_group_with_invite_code.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_group_id_by_invite_code(p_invite_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_group_id UUID;
  v_normalized_code TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  v_normalized_code := UPPER(REGEXP_REPLACE(TRIM(p_invite_code), '[^A-Z0-9]', '', 'g'));
  IF v_normalized_code = '' THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_group_id FROM public.groups
  WHERE UPPER(REGEXP_REPLACE(invite_code, '[^A-Z0-9]', '', 'g')) = v_normalized_code
  LIMIT 1;

  IF v_group_id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object('group_id', v_group_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_group_id_by_invite_code(TEXT) TO authenticated;


-- ============================================================
-- SECTION 2: remove_device_from_fleet RPC
-- ============================================================
-- Admin/owner-only action. Called from fleet.js when owner
-- long-presses a member card and taps "Remove".
-- purge=false: deactivates device + marks tracking OFFLINE
-- purge=true:  also deletes device row, tracking history, push tokens
-- ============================================================

CREATE OR REPLACE FUNCTION public.remove_device_from_fleet(
  device_id TEXT,
  purge BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_device_group_id UUID;
  v_is_owner BOOLEAN;
  v_did TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Not authenticated');
  END IF;

  v_did := TRIM(device_id);
  IF v_did IS NULL OR v_did = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Invalid device_id');
  END IF;

  -- Get the device's current group
  SELECT d.group_id INTO v_device_group_id
  FROM public.devices d
  WHERE d.device_id = v_did;

  IF v_device_group_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Device not found');
  END IF;

  -- Only fleet OWNER can remove devices
  SELECT EXISTS(
    SELECT 1 FROM public.groups g
    WHERE g.id = v_device_group_id AND g.owner_user_id = v_user_id
  ) INTO v_is_owner;

  IF NOT v_is_owner THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Only fleet owner can remove devices');
  END IF;

  IF purge THEN
    -- Full wipe: delete tracking history, device row, push tokens
    DELETE FROM public.tracking_sessions ts
    WHERE ts.device_id = v_did AND ts.group_id = v_device_group_id;

    DELETE FROM public.push_tokens pt
    WHERE pt.device_id = v_did AND pt.group_id = v_device_group_id;

    DELETE FROM public.devices d
    WHERE d.device_id = v_did;
  ELSE
    -- Soft remove: deactivate + mark OFFLINE
    UPDATE public.devices d
    SET is_active = false
    WHERE d.device_id = v_did;

    UPDATE public.tracking_sessions ts
    SET status = 'OFFLINE'
    WHERE ts.device_id = v_did AND ts.group_id = v_device_group_id;

    DELETE FROM public.push_tokens pt
    WHERE pt.device_id = v_did AND pt.group_id = v_device_group_id;
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.remove_device_from_fleet(TEXT, BOOLEAN) TO authenticated;


-- ============================================================
-- SECTION 3: RLS for group_members
-- ============================================================
-- Users can only SELECT their own memberships.
-- _layout.js does: group_members.select("group_id").eq("user_id", userId)
-- SECURITY DEFINER RPCs (join, leave, ensure_user_fleets) bypass RLS.
-- ============================================================

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own memberships" ON public.group_members;
CREATE POLICY "Users can read own memberships"
ON public.group_members FOR SELECT
USING (auth.uid() = user_id);


-- ============================================================
-- SECTION 4: RLS for groups
-- ============================================================
-- Users can SELECT groups they own OR are a member of.
-- _layout.js does: groups.select("id").eq("owner_user_id", userId)
-- fleet.js does:   groups.select("id, owner_user_id").eq("id", groupId)
-- SECURITY DEFINER RPCs bypass RLS for writes.
-- ============================================================

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own or joined groups" ON public.groups;
CREATE POLICY "Users can read own or joined groups"
ON public.groups FOR SELECT
USING (
  owner_user_id = auth.uid()
  OR
  EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = groups.id AND gm.user_id = auth.uid()
  )
);


-- ============================================================
-- SECTION 5: RLS for devices
-- ============================================================
-- Members/owners can SELECT devices in their fleet.
-- fleet.js does: devices.select("device_id").eq("group_id", gid).eq("is_active", true)
-- Without this policy, that query returns [] and wipes the fleet list.
-- SECURITY DEFINER RPCs (register_or_move_device) bypass RLS for writes.
-- ============================================================

ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Fleet members can read group devices" ON public.devices;
CREATE POLICY "Fleet members can read group devices"
ON public.devices FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = devices.group_id AND gm.user_id = auth.uid()
  )
  OR
  EXISTS (
    SELECT 1 FROM public.groups g
    WHERE g.id = devices.group_id AND g.owner_user_id = auth.uid()
  )
);

-- Devices also need UPDATE for logout (is_active = false)
DROP POLICY IF EXISTS "Users can update own devices" ON public.devices;
CREATE POLICY "Users can update own devices"
ON public.devices FOR UPDATE
USING (user_id = auth.uid());

-- Devices need INSERT for direct upsert fallback in deviceHandshake.js
DROP POLICY IF EXISTS "Users can insert own devices" ON public.devices;
CREATE POLICY "Users can insert own devices"
ON public.devices FOR INSERT
WITH CHECK (user_id = auth.uid());

-- Devices need DELETE (not currently used, but safe to have)
DROP POLICY IF EXISTS "Users can delete own devices" ON public.devices;
CREATE POLICY "Users can delete own devices"
ON public.devices FOR DELETE
USING (user_id = auth.uid());
