-- supabase/migrations/20260131_work_fleet_100_members.sql
-- Update: Work fleet can have 100 members, Family fleet stays at 50
-- ============================================

-- Drop and recreate the trigger function with fleet-type-aware limits
CREATE OR REPLACE FUNCTION public.check_fleet_member_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_member_count INTEGER;
  v_max_members INTEGER;
BEGIN
  -- Count current members in this group
  SELECT COUNT(*) INTO v_member_count FROM public.group_members WHERE group_id = NEW.group_id;

  -- Set max based on fleet type: Work = 100, Family = 50
  IF NEW.fleet_type = 'work' THEN
    v_max_members := 100;
  ELSE
    v_max_members := 50;
  END IF;

  IF v_member_count >= v_max_members THEN
    RAISE EXCEPTION 'Fleet member limit reached (maximum % members for % fleet)', v_max_members, NEW.fleet_type;
  END IF;

  RETURN NEW;
END;
$$;

-- ============================================
-- DONE
-- ============================================
