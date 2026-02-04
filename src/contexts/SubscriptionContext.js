/**
 * SubscriptionContext.js
 * Provides subscription state throughout the app
 */

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";
import SubscriptionService from "../services/SubscriptionService";
import { supabase } from "../lib/supabase";

const SubscriptionContext = createContext(null);

export function SubscriptionProvider({ children }) {
  const [loading, setLoading] = useState(true);
  const [hasAccess, setHasAccess] = useState(false);
  const [coverageType, setCoverageType] = useState("none"); // 'none', 'individual', 'enterprise', 'enterprise_member'
  const [plan, setPlan] = useState(null);
  const [expiresAt, setExpiresAt] = useState(null);
  const [companyName, setCompanyName] = useState(null);

  // Check subscription status
  const checkStatus = useCallback(async (forceRefresh = false) => {
    try {
      setLoading(true);
      const status = await SubscriptionService.checkSubscriptionStatus(forceRefresh);

      setHasAccess(status.hasAccess === true);
      setCoverageType(status.coverageType || "none");
      setPlan(status.plan || null);
      setExpiresAt(status.expiresAt || null);
      setCompanyName(status.companyName || null);

      return status;
    } catch (e) {
      console.log("Subscription check error:", e?.message || e);
      setHasAccess(false);
      return { hasAccess: false };
    } finally {
      setLoading(false);
    }
  }, []);

  // Initialize on mount and when auth changes
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const { data: { user } } = await supabase.auth.getUser();

      if (user && mounted) {
        // Initialize RevenueCat with user ID
        await SubscriptionService.initializePurchases(user.id);
        await SubscriptionService.identifyUser(user.id);
        await checkStatus();
      } else {
        setLoading(false);
      }
    };

    init();

    // Listen for auth changes
    const { data: authListener } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (!mounted) return;

        if (event === "SIGNED_IN" && session?.user) {
          await SubscriptionService.identifyUser(session.user.id);
          await checkStatus(true);
        } else if (event === "SIGNED_OUT") {
          await SubscriptionService.clearSubscriptionCache();
          setHasAccess(false);
          setCoverageType("none");
          setPlan(null);
        }
      }
    );

    return () => {
      mounted = false;
      authListener?.subscription?.unsubscribe();
    };
  }, [checkStatus]);

  // Refresh subscription
  const refresh = useCallback(() => checkStatus(true), [checkStatus]);

  const value = {
    loading,
    hasAccess,
    coverageType,
    plan,
    expiresAt,
    companyName,
    isIndividual: coverageType === "individual",
    isEnterprise: coverageType === "enterprise",
    isEnterpriseMember: coverageType === "enterprise_member",
    refresh,
    checkStatus,
  };

  return (
    <SubscriptionContext.Provider value={value}>
      {children}
    </SubscriptionContext.Provider>
  );
}

export function useSubscription() {
  const context = useContext(SubscriptionContext);
  if (!context) {
    throw new Error("useSubscription must be used within SubscriptionProvider");
  }
  return context;
}

export default SubscriptionContext;
