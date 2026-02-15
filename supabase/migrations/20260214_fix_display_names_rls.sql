-- Fix display name lookup for fleet members across different groups
-- Allows reading display_name for devices that appear in tracking_sessions
-- for groups where the user is a member, regardless of device's current group_id

CREATE OR REPLACE FUNCTION get_display_names_for_fleet(
  p_group_id UUID,
  p_device_ids TEXT[]
)
RETURNS TABLE(device_id TEXT, display_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Verify user is authorized to view this fleet
  IF NOT EXISTS (
    SELECT 1 FROM group_members gm
    WHERE gm.group_id = p_group_id AND gm.user_id = auth.uid()
  ) AND NOT EXISTS (
    SELECT 1 FROM groups g
    WHERE g.id = p_group_id AND g.owner_user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authorized to view this fleet';
  END IF;

  -- Return display names for devices that appear in tracking_sessions for this fleet
  -- This allows reading names even if device has moved to a different group
  RETURN QUERY
  SELECT DISTINCT
    d.device_id::TEXT,
    COALESCE(NULLIF(TRIM(d.display_name), ''), 'Device')::TEXT
  FROM devices d
  WHERE d.device_id = ANY(p_device_ids)
    AND EXISTS (
      SELECT 1 FROM tracking_sessions ts
      WHERE ts.device_id = d.device_id
        AND ts.group_id = p_group_id
    );
END;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION get_display_names_for_fleet(UUID, TEXT[]) TO authenticated;

COMMENT ON FUNCTION get_display_names_for_fleet IS 'Fetch display names for devices in a fleet, authorized by group membership';
