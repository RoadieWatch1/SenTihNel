# SOS Alert System Setup Guide

This guide walks you through setting up the fleet-wide SOS alert system.

## What Was Added

### New Files Created
- `src/services/AlarmService.js` - Loud alarm + vibration
- `src/services/NotificationService.js` - Push notification handling
- `src/services/SOSAlertManager.js` - Coordinates alerts across the app
- `src/components/SOSAlertOverlay.js` - Red flashing full-screen alert
- `supabase/migrations/20260128_push_tokens.sql` - Database tables
- `supabase/functions/send-sos-notifications/index.ts` - Edge Function

### Modified Files
- `app/(app)/_layout.js` - Initializes alert manager + renders overlay

---

## Setup Steps

### 1. Add Alarm Sound (Required for loud alert)

Add an alarm sound file to your assets:

```
assets/alarm.mp3
```

**Recommended:** Use a loud, attention-grabbing siren sound (5-10 seconds, will loop).

Free options:
- https://freesound.org/search/?q=alarm+siren
- https://mixkit.co/free-sound-effects/alarm/

### 2. Run Supabase Migration

In your Supabase SQL Editor, run the contents of:
```
supabase/migrations/20260128_push_tokens.sql
```

This creates:
- `push_tokens` table - Stores device push tokens
- `sos_notification_queue` table - Queues push notifications
- `notify_fleet_sos()` function - Triggers on SOS
- Database trigger on `tracking_sessions`

### 3. Deploy Edge Function

```bash
# From project root
supabase functions deploy send-sos-notifications
```

### 4. Set Up Webhook (Optional but Recommended)

In Supabase Dashboard:
1. Go to Database → Webhooks
2. Create new webhook:
   - Name: `sos-push-notifications`
   - Table: `sos_notification_queue`
   - Events: `INSERT`
   - URL: `https://your-project.supabase.co/functions/v1/send-sos-notifications`
   - Headers: Add `Authorization: Bearer YOUR_SERVICE_ROLE_KEY`

### 5. Configure Expo Push Notifications

In `app.json`, ensure you have:
```json
{
  "expo": {
    "plugins": [
      [
        "expo-notifications",
        {
          "sounds": ["./assets/alarm.mp3"]
        }
      ]
    ],
    "android": {
      "useNextNotificationsApi": true
    }
  }
}
```

### 6. Android: Add Notification Sound (Optional)

For custom notification sound on Android:
1. Create folder: `android/app/src/main/res/raw/`
2. Add `alarm.wav` (must be WAV format, not MP3)
3. Reference in NotificationService.js channel setup

---

## How It Works

### When SOS is Triggered (Victim's Phone)
1. `BatSignal.js` updates `tracking_sessions.status = 'SOS'`
2. Broadcasts to `fleet:${groupId}` realtime channel
3. Database trigger queues push notification

### Fleet Members Receive Alert

**If App is Open (Foreground):**
- `SOSAlertManager` receives realtime broadcast
- `AlarmService` starts loud alarm + vibration
- `SOSAlertOverlay` shows red flashing screen
- User can Acknowledge, View Location, or Dismiss

**If App is in Background:**
- Push notification arrives via Expo Push Service
- Phone vibrates (system notification)
- Tapping notification opens app → shows alert overlay

**If App is Closed:**
- Push notification wakes device
- User sees notification in system tray
- Tapping opens app → shows alert overlay

### Victim is Excluded
- Push tokens are filtered by `device_id != sender_device_id`
- Realtime handler checks `device_id !== myDeviceId`

---

## Testing

### Test In-App Alert
1. Open app on Device A (fleet member)
2. Open app on Device B (victim)
3. Trigger SOS on Device B
4. Device A should show red flashing overlay + alarm

### Test Push Notification
1. Open app on Device A, then background it
2. Trigger SOS on Device B
3. Device A should receive push notification
4. Tap notification → app opens with alert

### Test Edge Function Directly
```bash
curl -X POST \
  'https://your-project.supabase.co/functions/v1/send-sos-notifications' \
  -H 'Authorization: Bearer YOUR_ANON_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "payload": {
      "device_id": "test-device",
      "display_name": "Test User",
      "group_id": "your-group-id",
      "latitude": 0,
      "longitude": 0
    }
  }'
```

---

## Troubleshooting

### No Sound Playing
- Check `assets/alarm.mp3` exists
- Check device is not in silent mode (iOS)
- Verify `expo-av` is installed: `npx expo install expo-av`

### No Push Notifications
- Check device has notification permissions
- Verify push token is saved to `push_tokens` table
- Check Edge Function logs in Supabase Dashboard
- Ensure webhook is configured correctly

### Alert Not Showing
- Check `sentinel_group_id` is set in AsyncStorage
- Verify realtime subscription is connected (check console logs)
- Ensure both devices are in the same fleet/group

### iOS Critical Alerts
To bypass Do Not Disturb on iOS, you need Apple's approval for Critical Alerts.
Apply at: https://developer.apple.com/contact/request/notifications-critical-alerts-entitlement

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                         VICTIM DEVICE                           │
│  ┌─────────────┐    ┌─────────────┐    ┌──────────────────┐   │
│  │ Wake Word   │───▶│ BatSignal   │───▶│ Supabase         │   │
│  │ 7-Tap       │    │ .js         │    │ tracking_sessions│   │
│  │ SOS Button  │    └─────────────┘    └────────┬─────────┘   │
│  └─────────────┘                                │              │
└─────────────────────────────────────────────────│──────────────┘
                                                  │
                    ┌─────────────────────────────┴────────────┐
                    │                                          │
                    ▼                                          ▼
    ┌───────────────────────────┐          ┌───────────────────────────┐
    │    Realtime Broadcast     │          │    Database Trigger       │
    │    fleet:${groupId}       │          │    notify_fleet_sos()     │
    └─────────────┬─────────────┘          └─────────────┬─────────────┘
                  │                                      │
                  │                                      ▼
                  │                        ┌───────────────────────────┐
                  │                        │  sos_notification_queue   │
                  │                        └─────────────┬─────────────┘
                  │                                      │
                  │                                      ▼
                  │                        ┌───────────────────────────┐
                  │                        │  Edge Function            │
                  │                        │  send-sos-notifications   │
                  │                        └─────────────┬─────────────┘
                  │                                      │
                  │                                      ▼
                  │                        ┌───────────────────────────┐
                  │                        │  Expo Push API            │
                  │                        │  exp.host/--/api/v2/push  │
                  │                        └─────────────┬─────────────┘
                  │                                      │
                  ▼                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                      FLEET MEMBER DEVICES                        │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    SOSAlertManager                       │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │   │
│  │  │ AlarmService │  │ Notification │  │ SOSAlert     │  │   │
│  │  │ (sound+vibe) │  │ Service      │  │ Overlay      │  │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘  │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Cost

| Component | Cost |
|-----------|------|
| Expo Push Notifications | **Free** (unlimited) |
| Supabase Edge Functions | **Free** (500K invocations/month) |
| Supabase Realtime | **Free** (included) |
| Supabase Database | **Free** (included) |

**Total: $0/month** for typical usage
