# RevenueCat Setup Guide for SenTihNel

This guide walks you through setting up in-app subscriptions using RevenueCat.

## Overview

**Pricing:**
- Individual Monthly: $6.99/month
- Individual Yearly: $59.99/year (save $24)

**Product IDs:**
- `sentihnel_individual_monthly`
- `sentihnel_individual_yearly`

---

## Step 1: Create RevenueCat Account

1. Go to [https://app.revenuecat.com](https://app.revenuecat.com)
2. Sign up with your email
3. Create a new Project called "SenTihNel"

---

## Step 2: Set Up App Store Connect (iOS)

### 2.1 Create App (if not already done)
1. Go to [App Store Connect](https://appstoreconnect.apple.com)
2. My Apps > + > New App
3. Fill in app details

### 2.2 Create Subscriptions
1. Go to your app > Monetization > Subscriptions
2. Create a Subscription Group called "SenTihNel Premium"
3. Add two subscriptions:

**Monthly Subscription:**
- Reference Name: `SenTihNel Monthly`
- Product ID: `sentihnel_individual_monthly`
- Duration: 1 Month
- Price: $6.99

**Yearly Subscription:**
- Reference Name: `SenTihNel Yearly`
- Product ID: `sentihnel_individual_yearly`
- Duration: 1 Year
- Price: $59.99

4. For each subscription, add localization (display name, description)
5. Submit for review (can be done with app update)

### 2.3 Create Shared Secret
1. App Store Connect > Users and Access > Integrations > In-App Purchase
2. Generate App-Specific Shared Secret
3. Copy this - you'll need it for RevenueCat

---

## Step 3: Set Up Google Play Console (Android)

### 3.1 Create App (if not already done)
1. Go to [Google Play Console](https://play.google.com/console)
2. Create app if needed

### 3.2 Create Subscriptions
1. Go to your app > Monetize > Products > Subscriptions
2. Create two subscriptions:

**Monthly Subscription:**
- Product ID: `sentihnel_individual_monthly`
- Name: SenTihNel Monthly
- Base plan: 1 month, $6.99

**Yearly Subscription:**
- Product ID: `sentihnel_individual_yearly`
- Name: SenTihNel Yearly
- Base plan: 1 year, $59.99

### 3.3 Enable Google Play Billing
1. Go to Monetization setup
2. Link to your Google Cloud project
3. Create a service account with "Pub/Sub Admin" role
4. Download the JSON key file

---

## Step 4: Configure RevenueCat Dashboard

### 4.1 Add iOS App
1. RevenueCat Dashboard > Project > Apps > + New App
2. Select "App Store"
3. Enter your Bundle ID (from app.json: `com.sentihnel.app`)
4. Paste your App Store Shared Secret
5. Save

### 4.2 Add Android App
1. RevenueCat Dashboard > Project > Apps > + New App
2. Select "Play Store"
3. Enter your Package Name (from app.json)
4. Upload your service account JSON key
5. Save

### 4.3 Create Products
1. Go to Products in the sidebar
2. Click "+ New Product"
3. Add both products:
   - Identifier: `sentihnel_individual_monthly`
   - App Store Product ID: `sentihnel_individual_monthly`
   - Play Store Product ID: `sentihnel_individual_monthly`

   - Identifier: `sentihnel_individual_yearly`
   - App Store Product ID: `sentihnel_individual_yearly`
   - Play Store Product ID: `sentihnel_individual_yearly`

### 4.4 Create Entitlement
1. Go to Entitlements in the sidebar
2. Click "+ New Entitlement"
3. Identifier: `premium`
4. Attach both products to this entitlement

### 4.5 Create Offering
1. Go to Offerings in the sidebar
2. The "default" offering should exist
3. Add both packages:
   - Package: `$rc_monthly` -> `sentihnel_individual_monthly`
   - Package: `$rc_annual` -> `sentihnel_individual_yearly`

---

## Step 5: Get API Keys

1. RevenueCat Dashboard > Project > API Keys
2. Copy the **Public API Key** for each platform:
   - iOS (App Store): `appl_xxxxxxxxxxxxx`
   - Android (Play Store): `goog_xxxxxxxxxxxxx`

3. Update `src/services/SubscriptionService.js`:

```javascript
const REVENUECAT_API_KEY_IOS = "appl_YOUR_ACTUAL_KEY_HERE";
const REVENUECAT_API_KEY_ANDROID = "goog_YOUR_ACTUAL_KEY_HERE";
```

---

## Step 6: Set Up Supabase Webhook

This syncs subscription status from RevenueCat to your Supabase database.

### 6.1 Deploy the Edge Function
```bash
supabase functions deploy revenuecat-webhook
```

### 6.2 Set Webhook Secret
1. Generate a secret: `openssl rand -hex 32`
2. Supabase Dashboard > Project Settings > Edge Functions > Secrets
3. Add secret: `REVENUECAT_WEBHOOK_SECRET` = your generated secret

### 6.3 Configure RevenueCat Webhook
1. RevenueCat Dashboard > Project > Integrations > Webhooks
2. Click "+ New Webhook"
3. URL: `https://<your-project-ref>.supabase.co/functions/v1/revenuecat-webhook`
4. Authorization Header: `Bearer <your-webhook-secret>`
5. Select events:
   - INITIAL_PURCHASE
   - RENEWAL
   - CANCELLATION
   - UNCANCELLATION
   - EXPIRATION
   - BILLING_ISSUE
   - PRODUCT_CHANGE
6. Save

### 6.4 Get Your Supabase Function URL
```bash
supabase functions list
```
Or find it in Supabase Dashboard > Edge Functions

---

## Step 7: Testing

### 7.1 Sandbox Testing (iOS)
1. App Store Connect > Users and Access > Sandbox > Testers
2. Create a sandbox tester account
3. On your test device: Settings > App Store > Sign out
4. In the app, make a purchase - it will prompt for sandbox credentials
5. Sandbox subscriptions renew quickly (monthly = 5 minutes)

### 7.2 Testing (Android)
1. Google Play Console > Setup > License Testing
2. Add your test email addresses
3. These accounts can make test purchases without being charged

### 7.3 Verify Webhook
1. Make a test purchase
2. Check Supabase Dashboard > Edge Functions > Logs
3. Verify the subscription appears in your `subscriptions` table:
```sql
SELECT * FROM public.subscriptions ORDER BY created_at DESC LIMIT 5;
```

---

## Step 8: Go Live Checklist

- [ ] Real product IDs created in App Store Connect
- [ ] Real product IDs created in Google Play Console
- [ ] Products approved/active in both stores
- [ ] RevenueCat API keys updated in code
- [ ] Webhook deployed and configured
- [ ] Webhook secret set in Supabase
- [ ] Test purchase works on both platforms
- [ ] Subscription syncs to Supabase database

---

## Troubleshooting

### "No offerings available"
- Check that products are approved in App Store / Play Store
- Verify Product IDs match exactly (case-sensitive)
- Make sure Offering is set as "current" in RevenueCat

### "Subscription not syncing to Supabase"
- Check Edge Function logs for errors
- Verify webhook URL is correct
- Verify webhook secret matches
- Make sure `app_user_id` in RevenueCat matches Supabase user UUID

### "User has subscription but can't join fleet"
Run this SQL to debug:
```sql
SELECT public.debug_user_subscription('user-uuid-here');
```

Or manually grant access:
```sql
SELECT public.admin_grant_subscription('user@email.com', 1);
```

---

## Quick Reference

| Item | Value |
|------|-------|
| Monthly Product ID | `sentihnel_individual_monthly` |
| Yearly Product ID | `sentihnel_individual_yearly` |
| Entitlement ID | `premium` |
| Monthly Price | $6.99 |
| Yearly Price | $59.99 |
| Webhook Path | `/functions/v1/revenuecat-webhook` |
