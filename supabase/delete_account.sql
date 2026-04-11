-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- This creates the delete_account() RPC function that the Settings screen calls.
-- It runs with SECURITY DEFINER so it can delete the auth user row.

CREATE OR REPLACE FUNCTION public.delete_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Remove device-level rows
  DELETE FROM public.push_tokens       WHERE user_id = _uid;
  DELETE FROM public.user_sos_pins     WHERE user_id = _uid;
  DELETE FROM public.tracking_sessions WHERE user_id = _uid;
  DELETE FROM public.devices           WHERE user_id = _uid;

  -- Remove fleet membership and owned groups
  DELETE FROM public.group_members WHERE user_id = _uid;
  DELETE FROM public.groups        WHERE owner_user_id = _uid;

  -- Remove subscription record (billing history can be retained elsewhere if
  -- legally required, but the user→subscription link must not persist)
  DELETE FROM public.subscriptions WHERE user_id = _uid;

  -- Delete the auth user — requires SECURITY DEFINER + service_role privileges
  DELETE FROM auth.users WHERE id = _uid;
END;
$$;

-- Grant execute to authenticated users only
REVOKE ALL ON FUNCTION public.delete_account() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_account() TO authenticated;
