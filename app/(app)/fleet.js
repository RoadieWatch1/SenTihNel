// 📂 FILE: app/(app)/fleet.js
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

  // Throttle realtime refreshes
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

  // ✅ Fetch Fleet Data (NO nested join)
  const fetchFleet = async () => {
    setErrorText("");

    try {
      const { data, error } = await supabase
        .from("tracking_sessions")
        .select("device_id, group_id, latitude, longitude, battery_level, status, last_updated")
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

  // Sort: SOS first, then ACTIVE, then OFFLINE
  const sortedWorkers = useMemo(() => {
    const arr = Array.isArray(workers) ? [...workers] : [];
    const rank = (s) => {
      if (s === "SOS") return 0;
      if (s === "ACTIVE") return 1;
      if (s === "OFFLINE") return 2;
      return 3;
    };

    arr.sort((a, b) => {
      const ra = rank(a?.status);
      const rb = rank(b?.status);
      if (ra !== rb) return ra - rb;

      const aTime = a?.last_updated ? new Date(a.last_updated).getTime() : 0;
      const bTime = b?.last_updated ? new Date(b.last_updated).getTime() : 0;
      return bTime - aTime;
    });

    return arr;
  }, [workers]);

  useEffect(() => {
    fetchFleet();

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
          }, 800);
        }
      )
      .subscribe();

    return () => {
      if (refetchTimerRef.current) {
        clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
      supabase.removeChannel(channel);
    };
  }, []);

  const renderWorker = ({ item }) => {
    const status = item?.status || "UNKNOWN";
    const isSOS = status === "SOS";
    const isOnline = status === "ACTIVE" || isSOS;

    const lastSeen = safeTime(item?.last_updated);

    // ✅ For now, show device_id as the label
    const label = item?.device_id || "Unknown Device";

    return (
      <View style={[styles.card, isSOS && styles.cardSOS, isOnline && !isSOS && styles.cardActive]}>
        <View style={styles.cardHeader}>
          <View style={styles.row}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: isSOS ? "#ef4444" : isOnline ? "#22c55e" : "#64748b" },
              ]}
            />
            <View style={{ flexDirection: "column", flex: 1 }}>
              <Text style={[styles.workerName, isSOS && styles.workerNameSOS]}>{label}</Text>
              <Text style={[styles.subLabel, isSOS && styles.subLabelSOS]}>
                {isSOS ? "🚨 SOS" : isOnline ? "ONLINE" : "OFFLINE"} • Last: {lastSeen}
              </Text>
              {!!item?.group_id && (
                <Text style={styles.groupLine}>Group: {String(item.group_id).slice(0, 8)}…</Text>
              )}
            </View>
          </View>

          <Ionicons
            name={isSOS ? "warning" : isOnline ? "shield-checkmark" : "shield-outline"}
            size={18}
            color={isSOS ? "#ef4444" : isOnline ? "#22c55e" : "#64748b"}
          />
        </View>

        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Ionicons name="battery-half" size={16} color={isSOS ? "#fecaca" : "#94a3b8"} />
            <Text style={[styles.statText, isSOS && styles.statTextSOS]}>{safePercent(item?.battery_level)}</Text>
          </View>

          <View style={styles.stat}>
            <Ionicons name="location-outline" size={16} color={isSOS ? "#fecaca" : "#94a3b8"} />
            <Text style={[styles.statText, isSOS && styles.statTextSOS]}>{safeCoords(item?.latitude, item?.longitude)}</Text>
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
  
  // ✅ SOS styling (Red Border + Slight Red Tint)
  cardSOS: {
    borderColor: "#ef4444",
    borderWidth: 2,
    backgroundColor: "rgba(239, 68, 68, 0.1)",
  },
  
  // ✅ Active styling
  cardActive: {
    borderColor: "rgba(34, 197, 94, 0.3)",
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
  workerNameSOS: { color: "#fee2e2" },
  
  subLabel: { color: "#64748b", fontSize: 12, marginTop: 2, fontWeight: "700" },
  subLabelSOS: { color: "#fecaca" },
  
  groupLine: { color: "#475569", fontSize: 11, marginTop: 4, fontWeight: "700" },

  statsRow: { flexDirection: "row", gap: 18 },

  stat: { flexDirection: "row", alignItems: "center", gap: 6 },
  statText: { color: "#94a3b8", fontSize: 13, fontWeight: "700" },
  statTextSOS: { color: "#fee2e2" },

  emptyText: { color: "#475569", textAlign: "center", marginTop: 50, lineHeight: 20 },
});