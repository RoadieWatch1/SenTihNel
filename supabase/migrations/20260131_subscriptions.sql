-- supabase/migrations/20260131_subscriptions.sql
-- Subscription system: Individual ($7/month) + Enterprise (custom pricing)
-- ============================================

-- ============================================
-- 1. SUBSCRIPTIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Plan type
  plan TEXT NOT NULL CHECK (plan IN ('individual', 'enterprise')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired', 'pending')),

  -- Payment provider info
  provider TEXT CHECK (provider IN ('apple', 'google', 'stripe', 'manual')),
  provider_subscription_id TEXT, -- Apple/Google/Stripe subscription ID
  provider_product_id TEXT, -- Product ID from store

  -- Dates
  starts_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,

  -- Enterprise-specific
  seats_purchased INTEGER DEFAULT 1,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  CONSTRAINT unique_user_subscription UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON public.subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_expires ON public.subscriptions(expires_at);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can view their own subscription
DROP POLICY IF EXISTS "Users can view own subscription" ON public.subscriptions;
CREATE POLICY "Users can view own subscription"
ON public.subscriptions FOR SELECT USING (auth.uid() = user_id);

-- ============================================
-- 2. ENTERPRISE CODES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.enterprise_codes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,

  -- Owner info
  subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Code details
  code TEXT NOT NULL UNIQUE, -- e.g., "ACME-WORK-2024"
  group_id UUID REFERENCES public.groups(id) ON DELETE SET NULL,

  -- Seat management
  max_seats INTEGER NOT NULL DEFAULT 10,
  used_seats INTEGER NOT NULL DEFAULT 0,

  -- Status
  is_active BOOLEAN DEFAULT true,

  -- Metadata
  company_name TEXT,
  contact_email TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_enterprise_codes_code ON public.enterprise_codes(code);
CREATE INDEX IF NOT EXISTS idx_enterprise_codes_owner ON public.enterprise_codes(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_codes_group ON public.enterprise_codes(group_id);

ALTER TABLE public.enterprise_codes ENABLE ROW LEVEL SECURITY;

-- Owner can view their enterprise code
DROP POLICY IF EXISTS "Owner can view enterprise code" ON public.enterprise_codes;
CREATE POLICY "Owner can view enterprise code"
ON public.enterprise_codes FOR SELECT USING (auth.uid() = owner_user_id);

-- ============================================
-- 3. ENTERPRISE MEMBERS TABLE
-- (Users covered by an enterprise subscription)
-- ============================================
CREATE TABLE IF NOT EXISTS public.enterprise_members (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  enterprise_code_id UUID NOT NULL REFERENCES public.enterprise_codes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  covered_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT unique_enterprise_member UNIQUE (enterprise_code_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_enterprise_members_user ON public.enterprise_members(user_id);
CREATE INDEX IF NOT EXISTS idx_enterprise_members_code ON public.enterprise_members(enterprise_code_id);

ALTER TABLE public.enterprise_members ENABLE ROW LEVEL SECURITY;

-- Users can see if they're covered
DROP POLICY IF EXISTS "Users can view own enterprise membership" ON public.enterprise_members;
CREATE POLICY "Users can view own enterprise membership"
ON public.enterprise_members FOR SELECT USING (auth.uid() = user_id);

-- ============================================
-- 4. FUNCTION: Check if user has active subscription
-- ============================================
CREATE OR REPLACE FUNCTION public.check_subscription_status()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_sub RECORD;
  v_enterprise RECORD;
  v_is_covered BOOLEAN := false;
  v_coverage_type TEXT := 'none';
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('has_access', false, 'error', 'Not authenticated');
  END IF;

  -- Check for direct subscription
  SELECT * INTO v_sub
  FROM public.subscriptions
  WHERE user_id = v_user_id
    AND status = 'active'
    AND (expires_at IS NULL OR expires_at > now())
  LIMIT 1;

  IF v_sub.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'has_access', true,
      'coverage_type', v_sub.plan,
      'plan', v_sub.plan,
      'provider', v_sub.provider,
      'expires_at', v_sub.expires_at,
      'seats_purchased', v_sub.seats_purchased
    );
  END IF;

  -- Check if covered by enterprise
  SELECT ec.* INTO v_enterprise
  FROM public.enterprise_members em
  JOIN public.enterprise_codes ec ON ec.id = em.enterprise_code_id
  JOIN public.subscriptions s ON s.id = ec.subscription_id
  WHERE em.user_id = v_user_id
    AND ec.is_active = true
    AND s.status = 'active'
    AND (ec.expires_at IS NULL OR ec.expires_at > now())
    AND (s.expires_at IS NULL OR s.expires_at > now())
  LIMIT 1;

  IF v_enterprise.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'has_access', true,
      'coverage_type', 'enterprise_member',
      'enterprise_code', v_enterprise.code,
      'company_name', v_enterprise.company_name
    );
  END IF;

  -- No subscription
  RETURN jsonb_build_object(
    'has_access', false,
    'coverage_type', 'none'
  );
END;
$$;

-- ============================================
-- 5. FUNCTION: Join fleet with enterprise code
-- ============================================
CREATE OR REPLACE FUNCTION public.join_with_enterprise_code(p_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_enterprise RECORD;
  v_group_id UUID;
  v_already_member BOOLEAN;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Find the enterprise code
  SELECT ec.*, s.status as sub_status INTO v_enterprise
  FROM public.enterprise_codes ec
  JOIN public.subscriptions s ON s.id = ec.subscription_id
  WHERE UPPER(ec.code) = UPPER(TRIM(p_code))
    AND ec.is_active = true
    AND s.status = 'active'
    AND (ec.expires_at IS NULL OR ec.expires_at > now())
    AND (s.expires_at IS NULL OR s.expires_at > now())
  LIMIT 1;

  IF v_enterprise.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid or expired enterprise code');
  END IF;

  -- Check seat availability
  IF v_enterprise.used_seats >= v_enterprise.max_seats THEN
    RETURN jsonb_build_object('success', false, 'error', 'No seats available. Contact your administrator.');
  END IF;

  -- Check if already a member
  SELECT EXISTS(
    SELECT 1 FROM public.enterprise_members
    WHERE enterprise_code_id = v_enterprise.id AND user_id = v_user_id
  ) INTO v_already_member;

  IF NOT v_already_member THEN
    -- Add to enterprise members
    INSERT INTO public.enterprise_members (enterprise_code_id, user_id)
    VALUES (v_enterprise.id, v_user_id);

    -- Increment seat count
    UPDATE public.enterprise_codes
    SET used_seats = used_seats + 1
    WHERE id = v_enterprise.id;
  END IF;

  -- Join the fleet if group exists
  v_group_id := v_enterprise.group_id;
  IF v_group_id IS NOT NULL THEN
    -- Remove from any existing work fleet
    DELETE FROM public.group_members
    WHERE user_id = v_user_id AND fleet_type = 'work';

    -- Join the enterprise fleet
    INSERT INTO public.group_members (user_id, group_id, fleet_type)
    VALUES (v_user_id, v_group_id, 'work')
    ON CONFLICT (user_id, fleet_type) DO UPDATE SET group_id = EXCLUDED.group_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'company_name', v_enterprise.company_name,
    'group_id', v_group_id,
    'message', 'Welcome to ' || COALESCE(v_enterprise.company_name, 'the team') || '!'
  );
END;
$$;

-- ============================================
-- 6. FUNCTION: Validate in-app purchase receipt
-- (Called by webhook or app after purchase)
-- ============================================
CREATE OR REPLACE FUNCTION public.activate_subscription(
  p_provider TEXT,
  p_provider_subscription_id TEXT,
  p_provider_product_id TEXT,
  p_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_plan TEXT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Determine plan from product ID
  v_plan := 'individual'; -- Default, could parse from product_id

  -- Upsert subscription
  INSERT INTO public.subscriptions (
    user_id, plan, status, provider,
    provider_subscription_id, provider_product_id,
    starts_at, expires_at
  ) VALUES (
    v_user_id, v_plan, 'active', p_provider,
    p_provider_subscription_id, p_provider_product_id,
    now(), p_expires_at
  )
  ON CONFLICT (user_id) DO UPDATE SET
    status = 'active',
    provider = EXCLUDED.provider,
    provider_subscription_id = EXCLUDED.provider_subscription_id,
    provider_product_id = EXCLUDED.provider_product_id,
    expires_at = EXCLUDED.expires_at,
    updated_at = now();

  RETURN jsonb_build_object('success', true, 'plan', v_plan);
END;
$$;

-- ============================================
-- 7. FUNCTION: Cancel subscription
-- ============================================
CREATE OR REPLACE FUNCTION public.cancel_subscription()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  UPDATE public.subscriptions
  SET status = 'cancelled', cancelled_at = now(), updated_at = now()
  WHERE user_id = v_user_id;

  RETURN jsonb_build_object('success', true);
END;
$$;

-- ============================================
-- 8. FUNCTION: Get enterprise dashboard data (owner only)
-- ============================================
CREATE OR REPLACE FUNCTION public.get_enterprise_dashboard()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id UUID;
  v_enterprise RECORD;
  v_members JSONB;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  -- Get enterprise code owned by this user
  SELECT ec.*, s.expires_at as sub_expires_at INTO v_enterprise
  FROM public.enterprise_codes ec
  JOIN public.subscriptions s ON s.id = ec.subscription_id
  WHERE ec.owner_user_id = v_user_id
    AND ec.is_active = true
  LIMIT 1;

  IF v_enterprise.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'is_enterprise_owner', false);
  END IF;

  -- Get members
  SELECT jsonb_agg(
    jsonb_build_object(
      'user_id', em.user_id,
      'display_name', COALESCE(p.display_name, 'Unknown'),
      'joined_at', em.covered_at
    )
  ) INTO v_members
  FROM public.enterprise_members em
  LEFT JOIN public.profiles p ON p.id = em.user_id
  WHERE em.enterprise_code_id = v_enterprise.id;

  RETURN jsonb_build_object(
    'success', true,
    'is_enterprise_owner', true,
    'code', v_enterprise.code,
    'company_name', v_enterprise.company_name,
    'max_seats', v_enterprise.max_seats,
    'used_seats', v_enterprise.used_seats,
    'seats_available', v_enterprise.max_seats - v_enterprise.used_seats,
    'expires_at', v_enterprise.sub_expires_at,
    'members', COALESCE(v_members, '[]'::jsonb)
  );
END;
$$;

-- ============================================
-- 9. UPDATE: join_group_with_invite_code to check subscription
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
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;

  v_fleet_type := LOWER(COALESCE(p_fleet_type, 'family'));
  IF v_fleet_type NOT IN ('work', 'family') THEN
    v_fleet_type := 'family';
  END IF;

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

  -- Must have subscription or enterprise coverage
  IF NOT v_has_sub AND NOT v_is_enterprise_covered THEN
    RETURN jsonb_build_object('success', false, 'error', 'Subscription required to join a fleet');
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
-- 10. ADMIN FUNCTION: Create enterprise subscription
-- (Call from your admin panel or Supabase dashboard)
-- ============================================
CREATE OR REPLACE FUNCTION public.admin_create_enterprise(
  p_owner_email TEXT,
  p_company_name TEXT,
  p_max_seats INTEGER,
  p_code TEXT DEFAULT NULL,
  p_months INTEGER DEFAULT 12
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_owner_id UUID;
  v_sub_id UUID;
  v_code TEXT;
  v_group_id UUID;
BEGIN
  -- Find owner by email
  SELECT id INTO v_owner_id FROM auth.users WHERE email = p_owner_email LIMIT 1;

  IF v_owner_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'User not found with email: ' || p_owner_email);
  END IF;

  -- Generate code if not provided
  v_code := COALESCE(p_code, UPPER(SUBSTRING(p_company_name FROM 1 FOR 4)) || '-' ||
            UPPER(SUBSTRING(MD5(RANDOM()::TEXT) FROM 1 FOR 6)));

  -- Create or update subscription
  INSERT INTO public.subscriptions (
    user_id, plan, status, provider, seats_purchased,
    starts_at, expires_at
  ) VALUES (
    v_owner_id, 'enterprise', 'active', 'manual', p_max_seats,
    now(), now() + (p_months || ' months')::INTERVAL
  )
  ON CONFLICT (user_id) DO UPDATE SET
    plan = 'enterprise',
    status = 'active',
    provider = 'manual',
    seats_purchased = p_max_seats,
    expires_at = now() + (p_months || ' months')::INTERVAL,
    updated_at = now()
  RETURNING id INTO v_sub_id;

  -- Create Work fleet for the enterprise
  INSERT INTO public.groups (owner_user_id, invite_code)
  VALUES (v_owner_id, v_code || '-FLEET')
  RETURNING id INTO v_group_id;

  -- Add owner to fleet
  INSERT INTO public.group_members (user_id, group_id, fleet_type)
  VALUES (v_owner_id, v_group_id, 'work')
  ON CONFLICT (user_id, fleet_type) DO UPDATE SET group_id = EXCLUDED.group_id;

  -- Create enterprise code
  INSERT INTO public.enterprise_codes (
    subscription_id, owner_user_id, code, group_id,
    max_seats, company_name, contact_email,
    expires_at
  ) VALUES (
    v_sub_id, v_owner_id, v_code, v_group_id,
    p_max_seats, p_company_name, p_owner_email,
    now() + (p_months || ' months')::INTERVAL
  );

  RETURN jsonb_build_object(
    'success', true,
    'enterprise_code', v_code,
    'fleet_invite_code', v_code || '-FLEET',
    'group_id', v_group_id,
    'max_seats', p_max_seats,
    'expires_at', now() + (p_months || ' months')::INTERVAL
  );
END;
$$;

-- ============================================
-- DONE
-- ============================================
