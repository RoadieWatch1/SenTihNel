-- supabase/migrations/20260130_auto_trigger_sos_notifications.sql
-- Automatically send push notifications when SOS is triggered
-- Uses pg_net extension to call Expo Push API directly from Postgres

-- ============================================
-- ENABLE pg_net EXTENSION
-- ============================================
-- Note: pg_net must be enabled in Supabase Dashboard > Database > Extensions
-- If not available, notifications will be sent via client-side fallback
create extension if not exists pg_net with schema extensions;

-- ============================================
-- FUNCTION: Send SOS push notifications directly to Expo
-- This is called when items are inserted into sos_notification_queue
-- ============================================
create or replace function public.send_sos_push_notifications_direct()
returns trigger as $$
declare
  push_token_record record;
  expo_messages jsonb := '[]'::jsonb;
  expo_message jsonb;
  payload_data jsonb;
  sender_name text;
  request_id bigint;
begin
  -- Get payload from the queue item
  payload_data := new.payload;
  sender_name := coalesce(payload_data->>'display_name', 'A fleet member');

  -- Build array of push messages for all recipients in the group
  for push_token_record in
    select pt.push_token, pt.platform
    from public.push_tokens pt
    where pt.group_id = new.group_id
      and pt.device_id != new.sender_device_id
      and (pt.push_token like 'ExponentPushToken%' or pt.push_token like 'ExpoPushToken%')
  loop
    -- Build individual Expo push message
    expo_message := jsonb_build_object(
      'to', push_token_record.push_token,
      'title', '🚨 SOS ALERT',
      'body', sender_name || ' needs immediate help!',
      'data', jsonb_build_object(
        'type', 'sos',
        'device_id', payload_data->>'device_id',
        'display_name', sender_name,
        'latitude', payload_data->'latitude',
        'longitude', payload_data->'longitude',
        'timestamp', payload_data->>'timestamp',
        'group_id', payload_data->>'group_id'
      ),
      'sound', 'default',
      'priority', 'high',
      'badge', 1
    );

    -- Add Android channel ID for custom sound/vibration
    if push_token_record.platform = 'android' then
      expo_message := expo_message || jsonb_build_object('channelId', 'sos_alerts');
    end if;

    -- Add to messages array
    expo_messages := expo_messages || expo_message;
  end loop;

  -- If no recipients, mark as sent (nothing to do)
  if jsonb_array_length(expo_messages) = 0 then
    update public.sos_notification_queue
    set status = 'sent',
        error_message = 'No recipients found',
        processed_at = now()
    where id = new.id;
    return new;
  end if;

  -- Send batch to Expo Push API using pg_net
  begin
    select net.http_post(
      url := 'https://exp.host/--/api/v2/push/send',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Accept', 'application/json',
        'Accept-Encoding', 'gzip, deflate'
      ),
      body := expo_messages
    ) into request_id;

    -- Mark as sent (we fire-and-forget, can't wait for response in trigger)
    update public.sos_notification_queue
    set status = 'sent',
        processed_at = now()
    where id = new.id;

  exception when others then
    -- pg_net not available or request failed
    -- Leave as pending for Edge Function fallback
    raise warning 'pg_net send failed (will retry via Edge Function): %', sqlerrm;
  end;

  return new;
end;
$$ language plpgsql security definer;

-- ============================================
-- TRIGGER: Auto-send notifications on queue insert
-- ============================================
drop trigger if exists trigger_send_sos_push_notifications on public.sos_notification_queue;
create trigger trigger_send_sos_push_notifications
after insert on public.sos_notification_queue
for each row
execute function public.send_sos_push_notifications_direct();

-- ============================================
-- GRANT: Allow the function to use pg_net
-- ============================================
-- Guard grants: only apply if pg_net's objects exist
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'net') THEN
    BEGIN
      EXECUTE 'grant usage on schema net to postgres';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not grant usage on schema net: %', SQLERRM;
    END;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'net' AND p.proname = 'http_post'
  ) THEN
    BEGIN
      EXECUTE 'grant execute on function net.http_post(text, jsonb, jsonb, integer) to postgres';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not grant execute on net.http_post: %', SQLERRM;
    END;
  END IF;
END
$$;
