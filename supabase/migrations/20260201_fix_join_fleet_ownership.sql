-- ============================================
-- FIX: join_group_with_invite_code should use GROUP's fleet_type, not parameter
-- ============================================
-- Problem: When joining a Work fleet, the function used the p_fleet_type parameter
-- (defaults to 'family') instead of reading the group's actual fleet_type.
-- This caused subscribed users to only be able to join Family fleets.
-- ============================================

CREATE OR REPLACE FUNCTION public.join_group_with_invite_code(
  p_invite_code TEXT,
  p_fleet_type TEXT DEFAULT NULL  -- Now optional, will use group's fleet_type if not provided
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_group_id UUID;
  v_group_fleet_type TEXT;
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

  -- Normalize invite code
  v_normalized_code := UPPER(REGEXP_REPLACE(TRIM(p_invite_code), '[^A-Z0-9]', '', 'g'));
  IF v_normalized_code = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid invite code');
  END IF;

  -- Find the group AND get its fleet_type
  SELECT id, fleet_type INTO v_group_id, v_group_fleet_type
  FROM public.groups
  WHERE UPPER(REGEXP_REPLACE(invite_code, '[^A-Z0-9]', '', 'g')) = v_normalized_code
  LIMIT 1;

  IF v_group_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invite code not found');
  END IF;

  -- ✅ FIX: ALWAYS use the group's actual fleet_type (ignore parameter)
  -- This ensures users join Work fleets as 'work' and Family fleets as 'family'
  -- regardless of what the frontend passes
  v_fleet_type := COALESCE(v_group_fleet_type, 'family');

  -- Check if user OWNS this fleet (no subscription needed for own fleets)
  SELECT EXISTS(
    SELECT 1 FROM public.groups
    WHERE id = v_group_id AND owner_user_id = v_user_id
  ) INTO v_is_owner;

  -- Only check subscription if NOT the owner
  IF NOT v_is_owner THEN
    -- Check if user has active subscription (more permissive: any active status)
    SELECT EXISTS(
      SELECT 1 FROM public.subscriptions
      WHERE user_id = v_user_id
        AND status IN ('active', 'pending')  -- Include pending subscriptions
        AND (expires_at IS NULL OR expires_at > now())
    ) INTO v_has_sub;

    -- Check if covered by enterprise
    SELECT EXISTS(
      SELECT 1 FROM public.enterprise_members em
      JOIN public.enterprise_codes ec ON ec.id = em.enterprise_code_id
      JOIN public.subscriptions s ON s.id = ec.subscription_id
      WHERE em.user_id = v_user_id
        AND ec.is_active = true
        AND s.status IN ('active', 'pending')
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
          'is_owner', v_is_owner,
          'user_id', v_user_id,
          'target_group_id', v_group_id,
          'sub_info', (
            SELECT jsonb_build_object(
              'exists', COUNT(*) > 0,
              'status', MAX(status),
              'expires_at', MAX(expires_at),
              'is_expired', MAX(expires_at) < now()
            )
            FROM public.subscriptions WHERE user_id = v_user_id
          )
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
    RETURN jsonb_build_object(
      'success', true,
      'group_id', v_group_id,
      'fleet_type', v_fleet_type,
      'group_fleet_type', v_group_fleet_type,
      'action', 'updated',
      'is_owner', v_is_owner
    );
  END IF;

  INSERT INTO public.group_members (user_id, group_id, fleet_type)
  VALUES (v_user_id, v_group_id, v_fleet_type);

  RETURN jsonb_build_object(
    'success', true,
    'group_id', v_group_id,
    'fleet_type', v_fleet_type,
    'group_fleet_type', v_group_fleet_type,
    'action', 'joined',
    'is_owner', v_is_owner
  );
END;
$$;

-- Re-grant permissions
GRANT EXECUTE ON FUNCTION public.join_group_with_invite_code(TEXT, TEXT) TO authenticated;

-- ============================================
-- HELPER: Debug subscription status for a user
-- Run this in Supabase SQL editor to check a user's subscription:
-- SELECT * FROM public.debug_user_subscription('user-uuid-here');
-- ============================================
CREATE OR REPLACE FUNCTION public.debug_user_subscription(p_user_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_sub RECORD;
  v_enterprise RECORD;
BEGIN
  v_user_id := COALESCE(p_user_id, auth.uid());
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'No user ID provided');
  END IF;

  -- Get subscription details
  SELECT * INTO v_sub FROM public.subscriptions WHERE user_id = v_user_id;

  -- Get enterprise coverage
  SELECT em.*, ec.code, ec.is_active as code_active, s.status as sub_status
  INTO v_enterprise
  FROM public.enterprise_members em
  JOIN public.enterprise_codes ec ON ec.id = em.enterprise_code_id
  JOIN public.subscriptions s ON s.id = ec.subscription_id
  WHERE em.user_id = v_user_id
  LIMIT 1;

  RETURN jsonb_build_object(
    'user_id', v_user_id,
    'subscription', CASE WHEN v_sub.id IS NOT NULL THEN jsonb_build_object(
      'id', v_sub.id,
      'plan', v_sub.plan,
      'status', v_sub.status,
      'provider', v_sub.provider,
      'starts_at', v_sub.starts_at,
      'expires_at', v_sub.expires_at,
      'is_expired', v_sub.expires_at < now(),
      'is_active_and_valid', v_sub.status = 'active' AND (v_sub.expires_at IS NULL OR v_sub.expires_at > now())
    ) ELSE NULL END,
    'enterprise_coverage', CASE WHEN v_enterprise.id IS NOT NULL THEN jsonb_build_object(
      'code', v_enterprise.code,
      'code_active', v_enterprise.code_active,
      'sub_status', v_enterprise.sub_status
    ) ELSE NULL END,
    'has_any_access', (
      (v_sub.status = 'active' AND (v_sub.expires_at IS NULL OR v_sub.expires_at > now()))
      OR
      (v_enterprise.code_active = true AND v_enterprise.sub_status = 'active')
    )
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.debug_user_subscription(UUID) TO authenticated;

-- ============================================
-- HELPER: Force-activate subscription for a user (admin use)
-- Use this to manually grant subscription access if RevenueCat sync failed
-- ============================================
CREATE OR REPLACE FUNCTION public.admin_grant_subscription(
  p_user_email TEXT,
  p_months INTEGER DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  -- Find user by email
  SELECT id INTO v_user_id FROM auth.users WHERE email = p_user_email LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'User not found: ' || p_user_email);
  END IF;

  -- Upsert subscription
  INSERT INTO public.subscriptions (
    user_id, plan, status, provider, starts_at, expires_at
  ) VALUES (
    v_user_id, 'individual', 'active', 'manual',
    now(), now() + (p_months || ' months')::INTERVAL
  )
  ON CONFLICT (user_id) DO UPDATE SET
    status = 'active',
    expires_at = GREATEST(
      COALESCE(subscriptions.expires_at, now()),
      now()
    ) + (p_months || ' months')::INTERVAL,
    updated_at = now();

  RETURN jsonb_build_object(
    'success', true,
    'user_id', v_user_id,
    'expires_at', now() + (p_months || ' months')::INTERVAL
  );
END;
$$;
