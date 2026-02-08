-- ============================================
-- Allow users to CHANGE their SOS PIN (not just set once)
-- The original set_user_sos_pin blocked changes with
-- "PIN already set. Cannot be changed." which conflicts
-- with the app UI that allows PIN changes.
-- ============================================

-- Add updated_at column (missing from original table)
ALTER TABLE public.user_sos_pins
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Add UPDATE policy so SECURITY DEFINER function can update rows
DROP POLICY IF EXISTS "Users can update own PIN" ON public.user_sos_pins;
CREATE POLICY "Users can update own PIN"
ON public.user_sos_pins FOR UPDATE USING (auth.uid() = user_id);

-- Replace the function to allow PIN changes (was one-time-only)
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
    -- Update existing PIN instead of blocking
    UPDATE public.user_sos_pins
    SET pin_hash = p_pin_hash, updated_at = now()
    WHERE user_id = v_user_id;
    RETURN jsonb_build_object('success', true, 'updated', true);
  END IF;

  INSERT INTO public.user_sos_pins (user_id, pin_hash) VALUES (v_user_id, p_pin_hash);
  RETURN jsonb_build_object('success', true);
END;
$$;
