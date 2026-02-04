/**
 * Paywall.js
 * Subscription purchase screen
 */

import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import SubscriptionService from "../services/SubscriptionService";
import { useSubscription } from "../contexts/SubscriptionContext";

export default function Paywall({ onClose, onSuccess }) {
  const { refresh } = useSubscription();

  // State
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState(false);
  const [products, setProducts] = useState([]);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [showEnterpriseCode, setShowEnterpriseCode] = useState(false);
  const [enterpriseCode, setEnterpriseCode] = useState("");
  const [enterpriseLoading, setEnterpriseLoading] = useState(false);

  // Load products
  useEffect(() => {
    const loadProducts = async () => {
      setLoading(true);
      const prods = await SubscriptionService.getProducts();
      setProducts(prods);

      // Select monthly by default
      const monthly = prods.find((p) => p.duration === "MONTHLY");
      if (monthly) setSelectedProduct(monthly);
      else if (prods.length > 0) setSelectedProduct(prods[0]);

      setLoading(false);
    };

    loadProducts();
  }, []);

  // Handle purchase
  const handlePurchase = async () => {
    if (!selectedProduct) return;

    setPurchasing(true);
    try {
      const result = await SubscriptionService.purchaseSubscription(selectedProduct);

      if (result.success) {
        await refresh();
        onSuccess?.();
      } else if (result.cancelled) {
        // User cancelled - do nothing
      } else {
        Alert.alert("Purchase Failed", result.error || "Please try again");
      }
    } catch (e) {
      Alert.alert("Error", e?.message || "Purchase failed");
    } finally {
      setPurchasing(false);
    }
  };

  // Handle restore
  const handleRestore = async () => {
    setPurchasing(true);
    try {
      const result = await SubscriptionService.restorePurchases();

      if (result.hasSubscription) {
        await refresh();
        Alert.alert("Restored!", "Your subscription has been restored.");
        onSuccess?.();
      } else {
        Alert.alert("No Subscription Found", "No previous purchase was found.");
      }
    } catch (e) {
      Alert.alert("Error", e?.message || "Restore failed");
    } finally {
      setPurchasing(false);
    }
  };

  // Handle enterprise code
  const handleEnterpriseCode = async () => {
    const code = enterpriseCode.trim();
    if (!code) {
      Alert.alert("Enter Code", "Please enter your enterprise code");
      return;
    }

    setEnterpriseLoading(true);
    try {
      const result = await SubscriptionService.joinWithEnterpriseCode(code);

      if (result.success) {
        await refresh();
        Alert.alert("Welcome!", result.message || "You have joined the team.");
        onSuccess?.();
      } else {
        Alert.alert("Invalid Code", result.error || "Please check your code and try again.");
      }
    } catch (e) {
      Alert.alert("Error", e?.message || "Failed to join");
    } finally {
      setEnterpriseLoading(false);
    }
  };

  // Features list
  const features = [
    { icon: "shield-checkmark", text: "Silent SOS alerts to your fleet" },
    { icon: "people", text: "Create Family or Work fleets" },
    { icon: "location", text: "Real-time location sharing during emergencies" },
    { icon: "videocam", text: "Live video/audio streaming during SOS" },
    { icon: "notifications", text: "Instant push notifications" },
  ];

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={28} color="#94a3b8" />
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Logo & Title */}
          <View style={styles.heroSection}>
            <View style={styles.logoContainer}>
              <Ionicons name="shield" size={48} color="#22c55e" />
            </View>
            <Text style={styles.title}>Unlock SenTihNel</Text>
            <Text style={styles.subtitle}>
              Stay protected with silent emergency alerts
            </Text>
          </View>

          {/* Features */}
          <View style={styles.featuresSection}>
            {features.map((feature, index) => (
              <View key={index} style={styles.featureRow}>
                <View style={styles.featureIcon}>
                  <Ionicons name={feature.icon} size={20} color="#22c55e" />
                </View>
                <Text style={styles.featureText}>{feature.text}</Text>
              </View>
            ))}
          </View>

          {/* Loading */}
          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#22c55e" />
              <Text style={styles.loadingText}>Loading plans...</Text>
            </View>
          ) : (
            <>
              {/* Product Options */}
              <View style={styles.productsSection}>
                {products.map((product) => {
                  const isSelected = selectedProduct?.id === product.id;
                  const isMonthly = product.duration === "MONTHLY";
                  const isYearly = product.duration === "ANNUAL";

                  return (
                    <TouchableOpacity
                      key={product.id}
                      style={[
                        styles.productCard,
                        isSelected && styles.productCardSelected,
                      ]}
                      onPress={() => setSelectedProduct(product)}
                      activeOpacity={0.8}
                    >
                      {isYearly && (
                        <View style={styles.saveBadge}>
                          <Text style={styles.saveBadgeText}>SAVE 30%</Text>
                        </View>
                      )}

                      <View style={styles.productHeader}>
                        <View
                          style={[
                            styles.radioOuter,
                            isSelected && styles.radioOuterSelected,
                          ]}
                        >
                          {isSelected && <View style={styles.radioInner} />}
                        </View>
                        <Text style={styles.productTitle}>
                          {isMonthly ? "Monthly" : "Yearly"}
                        </Text>
                      </View>

                      <Text style={styles.productPrice}>{product.price}</Text>
                      <Text style={styles.productPeriod}>
                        {isMonthly ? "per month" : "per year"}
                      </Text>

                      {isYearly && (
                        <Text style={styles.productNote}>
                          Just {(product.priceValue / 12).toFixed(2)}/month
                        </Text>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Purchase Button */}
              <TouchableOpacity
                style={[
                  styles.purchaseBtn,
                  purchasing && styles.purchaseBtnDisabled,
                ]}
                onPress={handlePurchase}
                disabled={purchasing || !selectedProduct}
                activeOpacity={0.9}
              >
                {purchasing ? (
                  <ActivityIndicator color="#0b1220" />
                ) : (
                  <Text style={styles.purchaseBtnText}>
                    Start Protection
                  </Text>
                )}
              </TouchableOpacity>

              {/* Restore */}
              <TouchableOpacity
                style={styles.restoreBtn}
                onPress={handleRestore}
                disabled={purchasing}
              >
                <Text style={styles.restoreBtnText}>Restore Purchases</Text>
              </TouchableOpacity>
            </>
          )}

          {/* Divider */}
          <View style={styles.divider}>
            <View style={styles.dividerLine} />
            <Text style={styles.dividerText}>OR</Text>
            <View style={styles.dividerLine} />
          </View>

          {/* Enterprise Code Section */}
          <TouchableOpacity
            style={styles.enterpriseToggle}
            onPress={() => setShowEnterpriseCode(!showEnterpriseCode)}
          >
            <Ionicons name="briefcase-outline" size={20} color="#64748b" />
            <Text style={styles.enterpriseToggleText}>
              Have an enterprise code?
            </Text>
            <Ionicons
              name={showEnterpriseCode ? "chevron-up" : "chevron-down"}
              size={18}
              color="#64748b"
            />
          </TouchableOpacity>

          {showEnterpriseCode && (
            <View style={styles.enterpriseSection}>
              <Text style={styles.enterpriseHint}>
                If your employer provided an enterprise code, enter it below to
                get free access.
              </Text>

              <TextInput
                style={styles.enterpriseInput}
                placeholder="Enter enterprise code"
                placeholderTextColor="#475569"
                value={enterpriseCode}
                onChangeText={setEnterpriseCode}
                autoCapitalize="characters"
                autoCorrect={false}
              />

              <TouchableOpacity
                style={[
                  styles.enterpriseBtn,
                  enterpriseLoading && styles.enterpriseBtnDisabled,
                ]}
                onPress={handleEnterpriseCode}
                disabled={enterpriseLoading}
              >
                {enterpriseLoading ? (
                  <ActivityIndicator color="#22c55e" size="small" />
                ) : (
                  <Text style={styles.enterpriseBtnText}>Join Team</Text>
                )}
              </TouchableOpacity>
            </View>
          )}

          {/* Legal */}
          <Text style={styles.legalText}>
            Payment will be charged to your {Platform.OS === "ios" ? "Apple ID" : "Google Play"} account.
            Subscription auto-renews unless cancelled at least 24 hours before the end of the current period.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
  },

  header: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    paddingTop: 8,
  },

  closeBtn: {
    padding: 8,
  },

  scroll: {
    flex: 1,
  },

  scrollContent: {
    paddingHorizontal: 24,
    paddingBottom: 40,
  },

  heroSection: {
    alignItems: "center",
    marginTop: 16,
    marginBottom: 32,
  },

  logoContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "rgba(34, 197, 94, 0.15)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
  },

  title: {
    color: "#e2e8f0",
    fontSize: 28,
    fontWeight: "900",
    marginBottom: 8,
  },

  subtitle: {
    color: "#64748b",
    fontSize: 16,
    textAlign: "center",
  },

  featuresSection: {
    marginBottom: 32,
  },

  featureRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 14,
  },

  featureIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(34, 197, 94, 0.10)",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 14,
  },

  featureText: {
    color: "#e2e8f0",
    fontSize: 15,
    flex: 1,
  },

  loadingContainer: {
    alignItems: "center",
    padding: 40,
  },

  loadingText: {
    color: "#64748b",
    marginTop: 12,
  },

  productsSection: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 24,
  },

  productCard: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 2,
    borderColor: "#1e293b",
    borderRadius: 16,
    padding: 16,
    alignItems: "center",
  },

  productCardSelected: {
    borderColor: "#22c55e",
    backgroundColor: "rgba(34, 197, 94, 0.08)",
  },

  saveBadge: {
    position: "absolute",
    top: -10,
    right: -10,
    backgroundColor: "#22c55e",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },

  saveBadgeText: {
    color: "#0b1220",
    fontSize: 10,
    fontWeight: "900",
  },

  productHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
  },

  radioOuter: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#475569",
    marginRight: 8,
    justifyContent: "center",
    alignItems: "center",
  },

  radioOuterSelected: {
    borderColor: "#22c55e",
  },

  radioInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#22c55e",
  },

  productTitle: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "700",
  },

  productPrice: {
    color: "#e2e8f0",
    fontSize: 24,
    fontWeight: "900",
    marginBottom: 2,
  },

  productPeriod: {
    color: "#64748b",
    fontSize: 12,
  },

  productNote: {
    color: "#22c55e",
    fontSize: 11,
    marginTop: 8,
    fontWeight: "600",
  },

  purchaseBtn: {
    backgroundColor: "#22c55e",
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
    marginBottom: 12,
  },

  purchaseBtnDisabled: {
    opacity: 0.7,
  },

  purchaseBtnText: {
    color: "#0b1220",
    fontSize: 18,
    fontWeight: "900",
  },

  restoreBtn: {
    alignItems: "center",
    paddingVertical: 12,
  },

  restoreBtnText: {
    color: "#64748b",
    fontSize: 14,
    fontWeight: "600",
  },

  divider: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 24,
  },

  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: "#1e293b",
  },

  dividerText: {
    color: "#475569",
    fontSize: 12,
    marginHorizontal: 16,
  },

  enterpriseToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
  },

  enterpriseToggleText: {
    color: "#64748b",
    fontSize: 14,
  },

  enterpriseSection: {
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 12,
    padding: 16,
    marginTop: 12,
  },

  enterpriseHint: {
    color: "#64748b",
    fontSize: 13,
    textAlign: "center",
    marginBottom: 16,
  },

  enterpriseInput: {
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "#1e293b",
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: "#e2e8f0",
    fontSize: 16,
    textAlign: "center",
    letterSpacing: 2,
    marginBottom: 12,
  },

  enterpriseBtn: {
    backgroundColor: "rgba(34, 197, 94, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.3)",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },

  enterpriseBtnDisabled: {
    opacity: 0.7,
  },

  enterpriseBtnText: {
    color: "#22c55e",
    fontSize: 16,
    fontWeight: "700",
  },

  legalText: {
    color: "#475569",
    fontSize: 11,
    textAlign: "center",
    lineHeight: 16,
    marginTop: 24,
  },
});
