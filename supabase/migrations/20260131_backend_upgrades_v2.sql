-- supabase/migrations/20260131_backend_upgrades_v2.sql
-- Backend upgrades: 50 members/fleet, multi-fleet (2 per user), custom SOS PIN
-- VERSION 2: Handles existing data gracefully
-- ============================================

-- ============================================
-- 1. CUSTOM USER SOS PIN TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.user_sos_pins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pin_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT unique_user_sos_pin UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_sos_pins_user_id ON public.user_sos_pins(user_id);

ALTER TABLE public.user_sos_pins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own PIN" ON public.user_sos_pins;
CREATE POLICY "Users can view own PIN"
ON public.user_sos_pins FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own PIN" ON public.user_sos_pins;
CREATE POLICY "Users can insert own PIN"
ON public.user_sos_pins FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ============================================
-- 2. FUNCTION: Set SOS PIN (one-time only)
-- ============================================
CREATE OR REPLACE FUNCTION public.set_user_sos_pin(p_pin_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_existing UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  SELECT id INTO v_existing FROM public.user_sos_pins WHERE user_id = v_user_id LIMIT 1;

  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN already set. Cannot be changed.');
  END IF;

  INSERT INTO public.user_sos_pins (user_id, pin_hash) VALUES (v_user_id, p_pin_hash);
  RETURN jsonb_build_object('success', true);
END;
$$;

-- ============================================
-- 3. FUNCTION: Verify SOS PIN
-- ============================================
CREATE OR REPLACE FUNCTION public.verify_user_sos_pin(p_pin_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_stored_hash TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'error', 'Not authenticated');
  END IF;

  SELECT pin_hash INTO v_stored_hash FROM public.user_sos_pins WHERE user_id = v_user_id LIMIT 1;

  IF v_stored_hash IS NULL THEN
    RETURN jsonb_build_object('valid', false, 'error', 'No PIN set');
  END IF;

  IF v_stored_hash = p_pin_hash THEN
    RETURN jsonb_build_object('valid', true);
  ELSE
    RETURN jsonb_build_object('valid', false);
  END IF;
END;
$$;

-- ============================================
-- 4. FUNCTION: Check if user has PIN set
-- ============================================
CREATE OR REPLACE FUNCTION public.has_user_sos_pin()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_exists BOOLEAN;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('has_pin', false, 'error', 'Not authenticated');
  END IF;

  SELECT EXISTS(SELECT 1 FROM public.user_sos_pins WHERE user_id = v_user_id) INTO v_exists;
  RETURN jsonb_build_object('has_pin', v_exists);
END;
$$;

-- ============================================
-- 5. MULTI-FLEET: Add fleet_type column + constraints
-- ============================================

-- Add column if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'group_members' AND column_name = 'fleet_type'
  ) THEN
    ALTER TABLE public.group_members ADD COLUMN fleet_type TEXT DEFAULT 'family';
  END IF;
END $$;

-- Clean up duplicates: keep first as family, second as work, delete rest
DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    SELECT id, user_id,
           ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at ASC, id ASC) as rn
    FROM public.group_members
  LOOP
    IF rec.rn = 1 THEN
      UPDATE public.group_members SET fleet_type = 'family' WHERE id = rec.id;
    ELSIF rec.rn = 2 THEN
      UPDATE public.group_members SET fleet_type = 'work' WHERE id = rec.id;
    ELSE
      DELETE FROM public.group_members WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;

-- Drop old constraints that might conflict
DO $$
BEGIN
  ALTER TABLE public.group_members DROP CONSTRAINT IF EXISTS group_members_user_id_group_id_key;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.group_members DROP CONSTRAINT IF EXISTS unique_user_fleet_type;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE public.group_members DROP CONSTRAINT IF EXISTS unique_user_group;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Add new constraints
ALTER TABLE public.group_members ADD CONSTRAINT unique_user_fleet_type UNIQUE (user_id, fleet_type);
ALTER TABLE public.group_members ADD CONSTRAINT unique_user_group UNIQUE (user_id, group_id);

-- Add check constraint for valid fleet_type values
DO $$
BEGIN
  ALTER TABLE public.group_members DROP CONSTRAINT IF EXISTS group_members_fleet_type_check;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE public.group_members ADD CONSTRAINT group_members_fleet_type_check CHECK (fleet_type IN ('work', 'family'));

-- ============================================
-- 6. UPDATE JOIN RPC: Support fleet_type
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
-- 7. FUNCTION: Get user's fleets
-- ============================================
CREATE OR REPLACE FUNCTION public.get_user_fleets()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_fleets JSONB;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object(
      'group_id', gm.group_id,
      'fleet_type', gm.fleet_type,
      'invite_code', g.invite_code,
      'is_owner', (g.owner_user_id = v_user_id),
      'joined_at', gm.created_at
    )
  ) INTO v_fleets
  FROM public.group_members gm
  JOIN public.groups g ON g.id = gm.group_id
  WHERE gm.user_id = v_user_id;

  RETURN jsonb_build_object('success', true, 'fleets', COALESCE(v_fleets, '[]'::jsonb));
END;
$$;

-- ============================================
-- 8. 50 MEMBERS PER FLEET TRIGGER
-- ============================================
CREATE OR REPLACE FUNCTION public.check_fleet_member_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_member_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_member_count FROM public.group_members WHERE group_id = NEW.group_id;
  IF v_member_count >= 50 THEN
    RAISE EXCEPTION 'Fleet member limit reached (maximum 50 members)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_check_fleet_member_limit ON public.group_members;
CREATE TRIGGER trigger_check_fleet_member_limit
BEFORE INSERT ON public.group_members
FOR EACH ROW EXECUTE FUNCTION public.check_fleet_member_limit();

-- ============================================
-- 9. UPDATE CREATE GROUP RPC: Support fleet_type
-- ============================================
CREATE OR REPLACE FUNCTION public.create_group_auto_invite_code(
  p_fleet_type TEXT DEFAULT 'family'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_group_id UUID;
  v_invite_code TEXT;
  v_fleet_type TEXT;
  v_existing_membership UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  v_fleet_type := LOWER(COALESCE(p_fleet_type, 'family'));
  IF v_fleet_type NOT IN ('work', 'family') THEN
    v_fleet_type := 'family';
  END IF;

  SELECT gm.id INTO v_existing_membership FROM public.group_members gm
  WHERE gm.user_id = v_user_id AND gm.fleet_type = v_fleet_type LIMIT 1;

  IF v_existing_membership IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'You already have a ' || v_fleet_type || ' fleet. Leave it first to create a new one.');
  END IF;

  LOOP
    v_invite_code := UPPER(SUBSTRING(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT) FROM 1 FOR 7));
    IF NOT EXISTS (SELECT 1 FROM public.groups WHERE invite_code = v_invite_code) THEN EXIT; END IF;
  END LOOP;

  INSERT INTO public.groups (owner_user_id, invite_code) VALUES (v_user_id, v_invite_code) RETURNING id INTO v_group_id;
  INSERT INTO public.group_members (user_id, group_id, fleet_type) VALUES (v_user_id, v_group_id, v_fleet_type);

  RETURN jsonb_build_object('success', true, 'group_id', v_group_id, 'invite_code', v_invite_code, 'fleet_type', v_fleet_type);
END;
$$;

-- ============================================
-- 10. FUNCTION: Leave fleet by type
-- ============================================
CREATE OR REPLACE FUNCTION public.leave_fleet(p_fleet_type TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_fleet_type TEXT;
  v_deleted INTEGER;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  v_fleet_type := LOWER(COALESCE(p_fleet_type, 'family'));
  IF v_fleet_type NOT IN ('work', 'family') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid fleet type');
  END IF;

  DELETE FROM public.group_members WHERE user_id = v_user_id AND fleet_type = v_fleet_type;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted > 0 THEN
    RETURN jsonb_build_object('success', true, 'fleet_type', v_fleet_type);
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'No fleet of that type found');
  END IF;
END;
$$;

-- ============================================
-- DONE
-- ============================================
