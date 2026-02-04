# SenTihNel Subscription System Setup Guide

## Overview

This subscription system supports two tiers:

| Tier | Price | Payment Method | Features |
|------|-------|----------------|----------|
| **Individual** | $6.99/month or $59.99/year | Apple/Google In-App Purchases | Create/join fleets, SOS alerts |
| **Enterprise** | Custom pricing | Invoice/Stripe | Owner pays for team seats |

---

## Step 1: Install Dependencies

```bash
npm install react-native-purchases
npx pod-install  # iOS only
```

---

## Step 2: RevenueCat Setup

### 2.1 Create RevenueCat Account
1. Go to [https://app.revenuecat.com](https://app.revenuecat.com)
2. Create a free account
3. Create a new project called "SenTihNel"

### 2.2 Add Your Apps
1. Add iOS app:
   - Bundle ID: `com.yourcompany.sentihnel`
   - App Store Connect Shared Secret (get from App Store Connect)

2. Add Android app:
   - Package name: `com.yourcompany.sentihnel`
   - Service Account JSON (from Google Play Console)

### 2.3 Create Products

**In App Store Connect (iOS):**
1. Go to My Apps → Your App → Subscriptions
2. Create a Subscription Group: "Premium"
3. Create products:
   - `sentihnel_individual_monthly` - $6.99/month
   - `sentihnel_individual_yearly` - $59.99/year

**In Google Play Console (Android):**
1. Go to Monetize → Products → Subscriptions
2. Create products with same IDs

### 2.4 Add Products to RevenueCat
1. In RevenueCat dashboard → Products
2. Import products from App Store Connect / Google Play
3. Create an Entitlement called "premium"
4. Create an Offering called "default" with your products

### 2.5 Get API Keys
1. Go to Project Settings → API Keys
2. Copy:
   - iOS API Key (starts with `appl_`)
   - Android API Key (starts with `goog_`)

### 2.6 Update Your Code
Edit `src/services/SubscriptionService.js`:
```javascript
const REVENUECAT_API_KEY_IOS = "appl_YOUR_KEY_HERE";
const REVENUECAT_API_KEY_ANDROID = "goog_YOUR_KEY_HERE";
```

---

## Step 3: Set Up Webhooks (Sync with Supabase)

### 3.1 Create Supabase Edge Function

Create `supabase/functions/revenuecat-webhook/index.ts`:
```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

serve(async (req) => {
  const event = await req.json()

  const userId = event.app_user_id
  const productId = event.product_id
  const eventType = event.type

  if (eventType === 'INITIAL_PURCHASE' || eventType === 'RENEWAL') {
    await supabase.from('subscriptions').upsert({
      user_id: userId,
      plan: 'individual',
      status: 'active',
      provider: event.store,
      provider_subscription_id: event.original_transaction_id,
      provider_product_id: productId,
      expires_at: event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : null,
    }, { onConflict: 'user_id' })
  }

  if (eventType === 'CANCELLATION' || eventType === 'EXPIRATION') {
    await supabase.from('subscriptions')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
      .eq('user_id', userId)
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { "Content-Type": "application/json" },
  })
})
```

### 3.2 Deploy Edge Function
```bash
npx supabase functions deploy revenuecat-webhook
```

### 3.3 Configure Webhook in RevenueCat
1. Go to Project Settings → Integrations → Webhooks
2. Add webhook URL: `https://YOUR_PROJECT.supabase.co/functions/v1/revenuecat-webhook`
3. Select events: INITIAL_PURCHASE, RENEWAL, CANCELLATION, EXPIRATION

---

## Step 4: Database Migration

Run the subscription migration:
```bash
npx supabase db push
```

Or manually run `supabase/migrations/20260131_subscriptions.sql` in Supabase SQL editor.

---

## Step 5: Wrap Your App

In your root layout, add the SubscriptionProvider:

```javascript
import { SubscriptionProvider } from "./src/contexts/SubscriptionContext";

export default function App() {
  return (
    <SubscriptionProvider>
      <YourApp />
    </SubscriptionProvider>
  );
}
```

---

## Step 6: Show Paywall

When a user tries to access premium features:

```javascript
import Paywall from "./src/components/Paywall";
import { useSubscription } from "./src/contexts/SubscriptionContext";

function SomeScreen() {
  const { hasAccess } = useSubscription();
  const [showPaywall, setShowPaywall] = useState(false);

  if (!hasAccess) {
    return (
      <Paywall
        onClose={() => setShowPaywall(false)}
        onSuccess={() => {
          setShowPaywall(false);
          // User now has access!
        }}
      />
    );
  }

  return <YourPremiumContent />;
}
```

---

## Enterprise Management

### Creating an Enterprise Account (Admin Only)

Run this SQL in Supabase dashboard:
```sql
SELECT public.admin_create_enterprise(
  'owner@company.com',  -- Owner's email
  'Acme Corp',          -- Company name
  50,                   -- Number of seats
  'ACME-2024',          -- Optional custom code
  12                    -- Months of subscription
);
```

This returns:
```json
{
  "success": true,
  "enterprise_code": "ACME-2024",
  "fleet_invite_code": "ACME-2024-FLEET",
  "max_seats": 50,
  "expires_at": "2027-01-31T..."
}
```

### How Employees Join

1. Employee downloads app
2. On paywall, taps "Have an enterprise code?"
3. Enters code: `ACME-2024`
4. Automatically joins the Work fleet
5. No payment required!

---

## Pricing Recommendations

| Plan | Price | Notes |
|------|-------|-------|
| Monthly | $6.99 | Easy entry point |
| Yearly | $59.99 | 30% discount, better LTV |
| Enterprise (1-10) | $6/seat/month | Small team |
| Enterprise (11-50) | $5/seat/month | Medium team |
| Enterprise (51-100) | $4/seat/month | Large team |
| Enterprise (100+) | Custom | Contact sales |

---

## Testing

### Test In-App Purchases

**iOS:**
1. Create Sandbox Tester in App Store Connect
2. Sign out of App Store on device
3. Sign in with sandbox account when prompted

**Android:**
1. Add test email to Google Play Console → License Testing
2. Use test card numbers

### Test Enterprise Codes

```sql
-- Create a test enterprise for yourself
SELECT public.admin_create_enterprise(
  'your@email.com',
  'Test Corp',
  10,
  'TEST-CODE',
  1
);
```

---

## Revenue Estimates

| Scenario | Monthly Users | Revenue |
|----------|---------------|---------|
| 100 individual monthly | 100 | $699/mo |
| 50 individual + 1 enterprise (20 seats) | 70 | $449/mo |
| 500 individual + 5 enterprises (50 seats each) | 750 | $4,745/mo |

Remember: Apple/Google take 15-30% of individual subscriptions.

---

## Support

- RevenueCat Docs: https://docs.revenuecat.com
- Supabase Docs: https://supabase.com/docs
