-- supabase/migrations/20260131_fix_duplicates.sql
-- FIX: Clean up duplicate group_members before adding unique constraint
-- ============================================

-- Step 1: Add fleet_type column if it doesn't exist (without constraint yet)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'group_members'
    AND column_name = 'fleet_type'
  ) THEN
    ALTER TABLE public.group_members
    ADD COLUMN fleet_type TEXT DEFAULT 'family';
  END IF;
END $$;

-- Step 2: For users with multiple memberships, assign alternating fleet types
-- Keep the FIRST membership as 'family', make the SECOND one 'work'
-- Any additional memberships beyond 2 will be deleted

-- First, let's see what we're dealing with and fix it
DO $$
DECLARE
  rec RECORD;
  row_num INTEGER;
BEGIN
  -- Loop through each user who has multiple memberships
  FOR rec IN
    SELECT user_id, id, group_id,
           ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at ASC, id ASC) as rn
    FROM public.group_members
  LOOP
    IF rec.rn = 1 THEN
      -- First membership -> family
      UPDATE public.group_members SET fleet_type = 'family' WHERE id = rec.id;
    ELSIF rec.rn = 2 THEN
      -- Second membership -> work
      UPDATE public.group_members SET fleet_type = 'work' WHERE id = rec.id;
    ELSE
      -- Third+ membership -> delete (user can only have 2 fleets)
      DELETE FROM public.group_members WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;

-- Step 3: Now add the CHECK constraint for fleet_type values
DO $$
BEGIN
  -- Add check constraint if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'group_members_fleet_type_check'
  ) THEN
    ALTER TABLE public.group_members
    ADD CONSTRAINT group_members_fleet_type_check
    CHECK (fleet_type IN ('work', 'family'));
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Constraint might already exist with different name, ignore
  NULL;
END $$;

-- Step 4: Verify no duplicates remain
DO $$
DECLARE
  dup_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT user_id, fleet_type, COUNT(*)
    FROM public.group_members
    GROUP BY user_id, fleet_type
    HAVING COUNT(*) > 1
  ) dupes;

  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Still have % duplicate user/fleet_type combinations', dup_count;
  END IF;

  RAISE NOTICE 'No duplicates found. Safe to add unique constraint.';
END $$;

-- ============================================
-- DONE - Now run the main migration again
-- ============================================
