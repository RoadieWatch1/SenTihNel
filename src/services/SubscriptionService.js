/**
 * SubscriptionService.js
 * Handles in-app purchases via RevenueCat + Supabase sync
 *
 * Setup steps:
 * 1. Create RevenueCat account at https://app.revenuecat.com
 * 2. Add your app (iOS + Android)
 * 3. Create products in App Store Connect / Google Play Console
 * 4. Add products to RevenueCat
 * 5. Copy API keys below
 * 6. Set up webhooks to sync with Supabase
 */

import { Platform } from "react-native";
import Purchases from "react-native-purchases";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../lib/supabase";

// ============================================
// CONFIGURATION - Get these from RevenueCat Dashboard
// See REVENUECAT_SETUP.md for full instructions
// ============================================

// RevenueCat API Keys (Dashboard > Project > API Keys)
// iOS: App Store app > Public API Key
// Android: Play Store app > Public API Key
const REVENUECAT_API_KEY_IOS = "appl_YOUR_IOS_KEY_HERE"; // TODO: Replace with real key
const REVENUECAT_API_KEY_ANDROID = "goog_YOUR_ANDROID_KEY_HERE"; // TODO: Replace with real key

// Product IDs - Must match EXACTLY what you create in:
// - App Store Connect (iOS): App > In-App Purchases
// - Google Play Console (Android): App > Monetize > Products > Subscriptions
export const PRODUCT_IDS = {
  INDIVIDUAL_MONTHLY: "sentihnel_individual_monthly", // $6.99/month
  INDIVIDUAL_YEARLY: "sentihnel_individual_yearly", // $59.99/year (save $24)
};

// Entitlement ID (RevenueCat Dashboard > Project > Entitlements)
// This is the "unlock key" that grants premium access
const ENTITLEMENT_ID = "premium";

// Storage key
const STORAGE_KEY_SUB_CACHE = "sentinel_subscription_cache";

// ============================================
// INITIALIZE
// ============================================
let isInitialized = false;

export const initializePurchases = async (userId) => {
  if (isInitialized) return;

  try {
    const apiKey = Platform.OS === "ios"
      ? REVENUECAT_API_KEY_IOS
      : REVENUECAT_API_KEY_ANDROID;

    // Configure RevenueCat
    await Purchases.configure({
      apiKey,
      appUserID: userId || null, // null = anonymous, set after login
    });

    isInitialized = true;
    console.log("✅ RevenueCat initialized");

    // If we have a user ID, identify them
    if (userId) {
      await Purchases.logIn(userId);
    }
  } catch (e) {
    console.log("❌ RevenueCat init error:", e?.message || e);
  }
};

// ============================================
// IDENTIFY USER (call after login)
// ============================================
export const identifyUser = async (userId) => {
  if (!isInitialized) {
    await initializePurchases(userId);
    return;
  }

  try {
    await Purchases.logIn(userId);
    console.log("✅ RevenueCat user identified:", userId);
  } catch (e) {
    console.log("⚠️ RevenueCat identify error:", e?.message || e);
  }
};

// ============================================
// GET AVAILABLE PRODUCTS
// ============================================
export const getProducts = async () => {
  try {
    if (!isInitialized) await initializePurchases();

    const offerings = await Purchases.getOfferings();

    if (!offerings.current) {
      console.log("⚠️ No offerings available");
      return [];
    }

    // Return all available packages
    return offerings.current.availablePackages.map((pkg) => ({
      id: pkg.identifier,
      productId: pkg.product.identifier,
      title: pkg.product.title,
      description: pkg.product.description,
      price: pkg.product.priceString,
      priceValue: pkg.product.price,
      currency: pkg.product.currencyCode,
      duration: pkg.packageType, // MONTHLY, ANNUAL, etc.
      package: pkg, // Keep reference for purchase
    }));
  } catch (e) {
    console.log("❌ Get products error:", e?.message || e);
    return [];
  }
};

// ============================================
// PURCHASE SUBSCRIPTION
// ============================================
export const purchaseSubscription = async (packageToPurchase) => {
  try {
    if (!isInitialized) await initializePurchases();

    console.log("🛒 Starting purchase:", packageToPurchase.productId);

    // Make the purchase
    const { customerInfo } = await Purchases.purchasePackage(
      packageToPurchase.package
    );

    // Check if entitled
    const isActive = customerInfo.entitlements.active[ENTITLEMENT_ID];

    if (isActive) {
      console.log("✅ Purchase successful!");

      // Sync with Supabase
      await syncSubscriptionToSupabase(customerInfo);

      return {
        success: true,
        customerInfo,
      };
    }

    return {
      success: false,
      error: "Purchase completed but entitlement not active",
    };
  } catch (e) {
    if (e.userCancelled) {
      return { success: false, cancelled: true };
    }

    console.log("❌ Purchase error:", e?.message || e);
    return {
      success: false,
      error: e?.message || "Purchase failed",
    };
  }
};

// ============================================
// RESTORE PURCHASES
// ============================================
export const restorePurchases = async () => {
  try {
    if (!isInitialized) await initializePurchases();

    const customerInfo = await Purchases.restorePurchases();
    const isActive = customerInfo.entitlements.active[ENTITLEMENT_ID];

    if (isActive) {
      await syncSubscriptionToSupabase(customerInfo);
      return { success: true, hasSubscription: true };
    }

    return { success: true, hasSubscription: false };
  } catch (e) {
    console.log("❌ Restore error:", e?.message || e);
    return { success: false, error: e?.message };
  }
};

// ============================================
// CHECK SUBSCRIPTION STATUS
// ============================================
export const checkSubscriptionStatus = async (forceRefresh = false) => {
  try {
    // Check cache first
    if (!forceRefresh) {
      const cached = await getCachedStatus();
      if (cached && Date.now() - cached.checkedAt < 5 * 60 * 1000) {
        return cached;
      }
    }

    // Check Supabase first (includes enterprise coverage)
    const { data: subData } = await supabase.rpc("check_subscription_status");

    if (subData?.has_access) {
      const status = {
        hasAccess: true,
        coverageType: subData.coverage_type,
        plan: subData.plan,
        expiresAt: subData.expires_at,
        companyName: subData.company_name,
        checkedAt: Date.now(),
      };
      await cacheStatus(status);
      return status;
    }

    // Check RevenueCat as backup
    if (isInitialized) {
      try {
        const customerInfo = await Purchases.getCustomerInfo();
        const isActive = customerInfo.entitlements.active[ENTITLEMENT_ID];

        if (isActive) {
          // Sync to Supabase
          await syncSubscriptionToSupabase(customerInfo);

          const status = {
            hasAccess: true,
            coverageType: "individual",
            plan: "individual",
            expiresAt: customerInfo.entitlements.active[ENTITLEMENT_ID]
              .expirationDate,
            checkedAt: Date.now(),
          };
          await cacheStatus(status);
          return status;
        }
      } catch (e) {
        console.log("⚠️ RevenueCat check failed:", e?.message);
      }
    }

    // No subscription
    const status = {
      hasAccess: false,
      coverageType: "none",
      checkedAt: Date.now(),
    };
    await cacheStatus(status);
    return status;
  } catch (e) {
    console.log("❌ Subscription check error:", e?.message || e);
    return { hasAccess: false, error: e?.message };
  }
};

// ============================================
// SYNC TO SUPABASE
// ============================================
const syncSubscriptionToSupabase = async (customerInfo) => {
  try {
    const entitlement = customerInfo.entitlements.active[ENTITLEMENT_ID];
    if (!entitlement) return;

    const provider = Platform.OS === "ios" ? "apple" : "google";

    await supabase.rpc("activate_subscription", {
      p_provider: provider,
      p_provider_subscription_id: entitlement.identifier,
      p_provider_product_id: entitlement.productIdentifier,
      p_expires_at: entitlement.expirationDate,
    });

    console.log("✅ Synced subscription to Supabase");
  } catch (e) {
    console.log("⚠️ Sync to Supabase failed:", e?.message || e);
  }
};

// ============================================
// ENTERPRISE CODE HANDLING
// ============================================
export const joinWithEnterpriseCode = async (code) => {
  try {
    const { data, error } = await supabase.rpc("join_with_enterprise_code", {
      p_code: code,
    });

    if (error) throw error;

    if (data?.success) {
      // Clear cache to force refresh
      await AsyncStorage.removeItem(STORAGE_KEY_SUB_CACHE);
      return {
        success: true,
        companyName: data.company_name,
        message: data.message,
      };
    }

    return { success: false, error: data?.error || "Failed to join" };
  } catch (e) {
    console.log("❌ Enterprise join error:", e?.message || e);
    return { success: false, error: e?.message };
  }
};

// ============================================
// GET ENTERPRISE DASHBOARD (for owners)
// ============================================
export const getEnterpriseDashboard = async () => {
  try {
    const { data, error } = await supabase.rpc("get_enterprise_dashboard");
    if (error) throw error;
    return data;
  } catch (e) {
    console.log("❌ Enterprise dashboard error:", e?.message || e);
    return { success: false, error: e?.message };
  }
};

// ============================================
// CACHE HELPERS
// ============================================
const getCachedStatus = async () => {
  try {
    const cached = await AsyncStorage.getItem(STORAGE_KEY_SUB_CACHE);
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
};

const cacheStatus = async (status) => {
  try {
    await AsyncStorage.setItem(STORAGE_KEY_SUB_CACHE, JSON.stringify(status));
  } catch {}
};

// ============================================
// CLEAR ON LOGOUT
// ============================================
export const clearSubscriptionCache = async () => {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY_SUB_CACHE);
    if (isInitialized) {
      await Purchases.logOut();
    }
  } catch {}
};

// ============================================
// OPEN SUBSCRIPTION MANAGEMENT
// ============================================
export const openSubscriptionManagement = async () => {
  try {
    if (!isInitialized) return;

    const customerInfo = await Purchases.getCustomerInfo();
    const managementUrl = customerInfo.managementURL;

    if (managementUrl) {
      const { Linking } = require("react-native");
      await Linking.openURL(managementUrl);
      return true;
    }

    return false;
  } catch (e) {
    console.log("⚠️ Open management error:", e?.message || e);
    return false;
  }
};

export default {
  initializePurchases,
  identifyUser,
  getProducts,
  purchaseSubscription,
  restorePurchases,
  checkSubscriptionStatus,
  joinWithEnterpriseCode,
  getEnterpriseDashboard,
  clearSubscriptionCache,
  openSubscriptionManagement,
  PRODUCT_IDS,
};
