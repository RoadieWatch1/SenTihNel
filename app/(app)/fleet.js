import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { supabase } from "../../src/lib/supabase";
import { Ionicons } from "@expo/vector-icons";

export default function FleetScreen() {
  const [workers, setWorkers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorText, setErrorText] = useState("");

  // Throttle realtime refreshes (prevents spam / battery drain)
  const refetchTimerRef = useRef(null);

  const safeTime = (iso) => {
    try {
      if (!iso) return "—";
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return "—";
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "—";
    }
  };

  const safePercent = (n) => {
    const v = typeof n === "number" ? n : parseInt(n, 10);
    if (Number.isNaN(v)) return "—";
    return `${Math.max(0, Math.min(100, v))}%`;
  };

  const safeCoords = (lat, lng) => {
    if (typeof lat !== "number" || typeof lng !== "number") return "—";
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  };

  // 1) Fetch the Fleet Data
  const fetchFleet = async () => {
    setErrorText("");

    try {
      const { data, error } = await supabase
        .from("tracking_sessions")
        .select(
          `
          device_id,
          latitude,
          longitude,
          battery_level,
          status,
          last_updated,
          devices (
            label,
            user_id,
            group_id
          )
        `
        )
        .order("last_updated", { ascending: false });

      if (error) throw error;

      setWorkers(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error("Fleet fetch error:", err?.message || err);
      setErrorText(err?.message || "Failed to load fleet.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Optional: sort so ACTIVE shows first (still respects last_updated)
  const sortedWorkers = useMemo(() => {
    const arr = Array.isArray(workers) ? [...workers] : [];
    arr.sort((a, b) => {
      const aOnline = a?.status === "ACTIVE";
      const bOnline = b?.status === "ACTIVE";
      if (aOnline !== bOnline) return aOnline ? -1 : 1;

      const aTime = a?.last_updated ? new Date(a.last_updated).getTime() : 0;
      const bTime = b?.last_updated ? new Date(b.last_updated).getTime() : 0;
      return bTime - aTime;
    });
    return arr;
  }, [workers]);

  useEffect(() => {
    fetchFleet();

    // 2) Real-time Subscription: throttle refreshes
    const channel = supabase
      .channel("fleet_updates")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tracking_sessions" },
        () => {
          if (refetchTimerRef.current) return;

          refetchTimerRef.current = setTimeout(() => {
            refetchTimerRef.current = null;
            fetchFleet();
          }, 800); // throttle window
        }
      )
      .subscribe();

    return () => {
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
      // Correct cleanup for Supabase v2 realtime channels
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderWorker = ({ item }) => {
    const isOnline = item?.status === "ACTIVE";
    const lastSeen = safeTime(item?.last_updated);

    const label = item?.devices?.label || item?.device_id || "Unknown Device";

    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.row}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: isOnline ? "#22c55e" : "#64748b" },
              ]}
            />
            <View style={{ flexDirection: "column" }}>
              <Text style={styles.workerName}>{label}</Text>
              <Text style={styles.subLabel}>
                {isOnline ? "ONLINE" : "OFFLINE"} • Last: {lastSeen}
              </Text>
            </View>
          </View>

          <Ionicons
            name={isOnline ? "shield-checkmark" : "shield-outline"}
            size={18}
            color={isOnline ? "#22c55e" : "#64748b"}
          />
        </View>

        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Ionicons name="battery-half" size={16} color="#94a3b8" />
            <Text style={styles.statText}>{safePercent(item?.battery_level)}</Text>
          </View>

          <View style={styles.stat}>
            <Ionicons name="location-outline" size={16} color="#94a3b8" />
            <Text style={styles.statText}>{safeCoords(item?.latitude, item?.longitude)}</Text>
          </View>
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#22c55e" />
        <Text style={styles.loadingText}>Loading fleet…</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Fleet Manager</Text>
        <Text style={styles.headerSub}>
          {sortedWorkers.length} device{sortedWorkers.length === 1 ? "" : "s"} visible
        </Text>

        {!!errorText && <Text style={styles.errorText}>⚠ {errorText}</Text>}
      </View>

      <FlatList
        data={sortedWorkers}
        keyExtractor={(item) => item.device_id}
        renderItem={renderWorker}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              fetchFleet();
            }}
            tintColor="#22c55e"
          />
        }
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            No devices are reporting yet.
            {"\n"}(Once a worker logs in + GPS syncs, they will appear here.)
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b1220" },
  centered: {
    flex: 1,
    backgroundColor: "#0b1220",
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: { color: "#475569", marginTop: 12, fontSize: 12 },

  header: { padding: 22, paddingTop: 56, backgroundColor: "#0f172a" },
  headerTitle: { color: "white", fontSize: 24, fontWeight: "900", letterSpacing: 1 },
  headerSub: { color: "#94a3b8", fontSize: 13, marginTop: 6 },
  errorText: { color: "#fca5a5", marginTop: 10, fontSize: 12 },

  list: { padding: 14 },

  card: {
    backgroundColor: "#1e293b",
    padding: 14,
    borderRadius: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#0f172a",
  },

  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 10,
  },

  row: { flexDirection: "row", alignItems: "flex-start" },

  statusDot: { width: 8, height: 8, borderRadius: 999, marginRight: 10, marginTop: 6 },

  workerName: { color: "white", fontWeight: "900", fontSize: 16 },
  subLabel: { color: "#64748b", fontSize: 12, marginTop: 2, fontWeight: "700" },

  statsRow: { flexDirection: "row", gap: 18 },

  stat: { flexDirection: "row", alignItems: "center", gap: 6 },
  statText: { color: "#94a3b8", fontSize: 13, fontWeight: "700" },

  emptyText: { color: "#475569", textAlign: "center", marginTop: 50, lineHeight: 20 },
});
