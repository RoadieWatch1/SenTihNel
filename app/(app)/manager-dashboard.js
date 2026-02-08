/**
 * Work Fleet Manager Dashboard
 * Shows all Work fleet members' locations for the fleet owner
 */
import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
  Platform,
  Linking,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../src/lib/supabase";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

// RPC function names
const RPC_IS_WORK_FLEET_OWNER = "is_work_fleet_owner";
const RPC_GET_MEMBERS_LOCATIONS = "get_work_fleet_members_locations";
const RPC_BLOCK_USER = "block_user_from_fleet";
const RPC_UNBLOCK_USER = "unblock_user_from_fleet";
const RPC_GET_BLOCKED = "get_blocked_users";

// Refresh interval (15 seconds)
const REFRESH_INTERVAL_MS = 15000;

export default function ManagerDashboard() {
  const navigation = useNavigation();

  // State
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [hasWorkFleet, setHasWorkFleet] = useState(false);
  const [members, setMembers] = useState([]);
  const [memberCount, setMemberCount] = useState(0);
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [selectedMember, setSelectedMember] = useState(null);

  // Block/unblock state
  const [blockedUsers, setBlockedUsers] = useState([]);
  const [showBlockedSection, setShowBlockedSection] = useState(false);
  const [blockingUserId, setBlockingUserId] = useState(null);

  // Auto-refresh timer
  const refreshTimerRef = useRef(null);
  // ✅ Real-time SOS: store group_id for broadcast subscription
  const groupIdRef = useRef(null);
  const broadcastChannelRef = useRef(null);
  const isMountedRef = useRef(true);
  const fetchRef = useRef(null);

  // Check if user is Work fleet owner
  const checkOwnership = useCallback(async () => {
    try {
      const { data, error: err } = await supabase.rpc(RPC_IS_WORK_FLEET_OWNER);
      if (err) throw err;

      setIsOwner(data?.is_owner === true);
      setHasWorkFleet(data?.has_work_fleet === true);
      setInviteCode(data?.invite_code || "");
      setMemberCount(data?.member_count || 0);
      // ✅ Store group_id for real-time SOS subscription
      if (data?.group_id) groupIdRef.current = data.group_id;

      return data?.is_owner === true;
    } catch (e) {
      console.log("checkOwnership error:", e?.message || e);
      setError("Failed to verify fleet ownership");
      return false;
    }
  }, []);

  // Fetch member locations
  const fetchMemberLocations = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);

      const { data, error: err } = await supabase.rpc(RPC_GET_MEMBERS_LOCATIONS);

      if (err) throw err;

      if (!data?.success) {
        setError(data?.error || "Failed to load member data");
        return;
      }

      setMembers(data?.members || []);
      setMemberCount(data?.member_count || 0);
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      console.log("fetchMemberLocations error:", e?.message || e);
      setError("Failed to load member locations");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial load (with timeout to prevent infinite loading on expired auth)
  useEffect(() => {
    const init = async () => {
      try {
        let ownerOk = false;
        try {
          ownerOk = await Promise.race([
            checkOwnership(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
          ]);
        } catch (e) {
          console.log("checkOwnership timed out or failed:", e?.message || e);
          setError("Could not verify fleet ownership. Pull down to retry.");
        }
        if (ownerOk) {
          await fetchMemberLocations();
        }
      } catch (e) {
        console.log("Dashboard init error:", e?.message || e);
        setError("Could not load dashboard. Pull down to retry.");
      } finally {
        setLoading(false);
      }
    };
    init();
  }, [checkOwnership, fetchMemberLocations]);

  // ✅ Safety timeout: if loading stays true for 12 seconds, force-stop
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => {
      if (loading) {
        console.log("⚠️ Dashboard loading safety timeout (12s)");
        setLoading(false);
        setError("Loading timed out. Pull down to retry.");
      }
    }, 12000);
    return () => clearTimeout(timer);
  }, [loading]);

  // Auto-refresh when owner
  useEffect(() => {
    if (!isOwner) return;

    refreshTimerRef.current = setInterval(() => {
      fetchMemberLocations(true);
    }, REFRESH_INTERVAL_MS);

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
    };
  }, [isOwner, fetchMemberLocations]);

  // ✅ Keep fetchRef in sync for broadcast handler
  fetchRef.current = fetchMemberLocations;

  // ✅ Real-time SOS subscription — instant alerts instead of 15s polling delay
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!isOwner || !groupIdRef.current) return;

    // Clean up previous channel
    if (broadcastChannelRef.current) {
      try { supabase.removeChannel(broadcastChannelRef.current); } catch {}
      broadcastChannelRef.current = null;
    }

    const gid = groupIdRef.current;
    const ch = supabase
      .channel(`fleet:${gid}`)
      .on("broadcast", { event: "sos" }, () => {
        console.log("📡 Dashboard: SOS broadcast received — refreshing immediately");
        if (fetchRef.current) fetchRef.current(true);
      })
      .on("broadcast", { event: "sos_cancel" }, () => {
        console.log("📡 Dashboard: SOS cancel broadcast received — refreshing");
        if (fetchRef.current) fetchRef.current(true);
      })
      .subscribe();

    broadcastChannelRef.current = ch;

    return () => {
      if (broadcastChannelRef.current) {
        try { supabase.removeChannel(broadcastChannelRef.current); } catch {}
        broadcastChannelRef.current = null;
      }
    };
  }, [isOwner]);

  // Fetch blocked users
  const fetchBlockedUsers = useCallback(async () => {
    try {
      const { data, error: err } = await supabase.rpc(RPC_GET_BLOCKED);
      if (err) throw err;
      if (data?.success) {
        setBlockedUsers(data?.blocked_users || []);
      }
    } catch (e) {
      console.log("fetchBlockedUsers error:", e?.message || e);
    }
  }, []);

  // Load blocked users when owner
  useEffect(() => {
    if (isOwner) {
      fetchBlockedUsers();
    }
  }, [isOwner, fetchBlockedUsers]);

  // Block a user
  const handleBlockUser = (member) => {
    Alert.alert(
      "Block User",
      `Are you sure you want to block ${member.display_name || "this user"} from your fleet?\n\nThey will be removed and cannot rejoin.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Block",
          style: "destructive",
          onPress: async () => {
            setBlockingUserId(member.user_id);
            try {
              const { data, error: err } = await supabase.rpc(RPC_BLOCK_USER, {
                p_user_id: member.user_id,
              });
              if (err) throw err;
              if (data?.success) {
                // Refresh members and blocked list
                await Promise.all([fetchMemberLocations(true), fetchBlockedUsers()]);
                setSelectedMember(null);
              } else {
                Alert.alert("Error", data?.error || "Failed to block user");
              }
            } catch (e) {
              Alert.alert("Error", e?.message || "Failed to block user");
            } finally {
              setBlockingUserId(null);
            }
          },
        },
      ]
    );
  };

  // Unblock a user
  const handleUnblockUser = (blockedUser) => {
    Alert.alert(
      "Unblock User",
      `Allow ${blockedUser.display_name || "this user"} to rejoin your fleet?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unblock",
          onPress: async () => {
            try {
              const { data, error: err } = await supabase.rpc(RPC_UNBLOCK_USER, {
                p_user_id: blockedUser.user_id,
              });
              if (err) throw err;
              if (data?.success) {
                await fetchBlockedUsers();
              } else {
                Alert.alert("Error", data?.error || "Failed to unblock user");
              }
            } catch (e) {
              Alert.alert("Error", e?.message || "Failed to unblock user");
            }
          },
        },
      ]
    );
  };

  // Open drawer
  const openDrawer = () => {
    try {
      navigation.openDrawer();
    } catch (e) {
      console.log("Drawer open warning:", e?.message || e);
    }
  };

  // Get status color
  const getStatusColor = (status) => {
    switch (status?.toUpperCase()) {
      case "SOS":
        return "#ef4444";
      case "ACTIVE":
        return "#22c55e";
      case "OFFLINE":
        return "#6b7280";
      default:
        return "#fbbf24";
    }
  };

  // Format last updated time
  const formatLastUpdated = (dateStr) => {
    if (!dateStr) return "Unknown";
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  };

  // Open location in Google Maps
  const openInMaps = (lat, lng, name) => {
    const url = Platform.select({
      ios: `maps:0,0?q=${lat},${lng}(${encodeURIComponent(name)})`,
      android: `geo:${lat},${lng}?q=${lat},${lng}(${encodeURIComponent(name)})`,
    });
    Linking.openURL(url).catch(() => {
      // Fallback to Google Maps web
      Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${lat},${lng}`);
    });
  };

  // Render member card
  const renderMemberCard = (member, index) => {
    const statusColor = getStatusColor(member.status);
    const hasLocation =
      typeof member.latitude === "number" && typeof member.longitude === "number";
    const isSelected = selectedMember?.user_id === member.user_id;

    return (
      <TouchableOpacity
        key={member.user_id || index}
        style={[
          styles.memberCard,
          member.status === "SOS" && styles.memberCardSOS,
          isSelected && styles.memberCardSelected,
        ]}
        onPress={() => setSelectedMember(isSelected ? null : member)}
        activeOpacity={0.8}
      >
        <View style={styles.memberHeader}>
          <View style={styles.memberNameRow}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={styles.memberName}>{member.display_name || "Member"}</Text>
          </View>
          <View style={[styles.statusBadge, { borderColor: statusColor }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>
              {member.status || "UNKNOWN"}
            </Text>
          </View>
        </View>

        <View style={styles.memberDetails}>
          {hasLocation ? (
            <TouchableOpacity
              style={styles.detailRow}
              onPress={() => openInMaps(member.latitude, member.longitude, member.display_name || "Member")}
            >
              <Ionicons name="location-outline" size={14} color="#22c55e" />
              <Text style={styles.detailTextLink}>
                {member.latitude.toFixed(4)}, {member.longitude.toFixed(4)}
              </Text>
              <Ionicons name="open-outline" size={12} color="#22c55e" />
            </TouchableOpacity>
          ) : (
            <View style={styles.detailRow}>
              <Ionicons name="location-outline" size={14} color="#64748b" />
              <Text style={styles.detailTextMuted}>No location data</Text>
            </View>
          )}

          <View style={styles.detailRow}>
            <Ionicons name="battery-half-outline" size={14} color="#64748b" />
            <Text style={styles.detailText}>
              {member.battery_level >= 0 ? `${member.battery_level}%` : "N/A"}
            </Text>
          </View>

          <View style={styles.detailRow}>
            <Ionicons name="time-outline" size={14} color="#64748b" />
            <Text style={styles.detailText}>
              {formatLastUpdated(member.last_updated)}
            </Text>
          </View>
        </View>

        {/* Expanded view for selected member */}
        {isSelected && (
          <View style={styles.expandedActions}>
            {hasLocation && (
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={() => openInMaps(member.latitude, member.longitude, member.display_name || "Member")}
              >
                <Ionicons name="navigate-outline" size={18} color="#22c55e" />
                <Text style={styles.actionBtnText}>Open in Maps</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.blockBtn}
              onPress={() => handleBlockUser(member)}
              disabled={blockingUserId === member.user_id}
            >
              {blockingUserId === member.user_id ? (
                <ActivityIndicator size="small" color="#ef4444" />
              ) : (
                <>
                  <Ionicons name="ban-outline" size={18} color="#ef4444" />
                  <Text style={styles.blockBtnText}>Block from Fleet</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // Not a Work fleet owner
  if (!loading && (!hasWorkFleet || !isOwner)) {
    return (
      <SafeAreaView style={styles.container}>
        <TouchableOpacity onPress={openDrawer} style={styles.menuBtn}>
          <Ionicons name="menu" size={28} color="#e5e7eb" />
        </TouchableOpacity>

        <View style={styles.centerContent}>
          <Ionicons name="briefcase-outline" size={64} color="#475569" />
          <Text style={styles.emptyTitle}>
            {!hasWorkFleet ? "No Work Fleet" : "Not Fleet Owner"}
          </Text>
          <Text style={styles.emptySubtitle}>
            {!hasWorkFleet
              ? "Create or join a Work fleet to access the Manager Dashboard."
              : "Only the fleet creator can access the Manager Dashboard to track members."}
          </Text>

          <View style={styles.helpBox}>
            <Text style={styles.helpTitle}>How to create a Work Fleet:</Text>
            <Text style={styles.helpText}>
              1. Go to Fleet Manager screen{"\n"}
              2. Tap "Switch Fleet" or join with invite code{"\n"}
              3. Select "Work" as fleet type{"\n"}
              4. Share the invite code with your team
            </Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // Loading
  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.centerContent}>
          <ActivityIndicator size="large" color="#22c55e" />
          <Text style={styles.loadingText}>Loading Dashboard...</Text>
        </View>
      </SafeAreaView>
    );
  }

  // Error state
  if (error && members.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        <TouchableOpacity onPress={openDrawer} style={styles.menuBtn}>
          <Ionicons name="menu" size={28} color="#e5e7eb" />
        </TouchableOpacity>

        <View style={styles.centerContent}>
          <Ionicons name="alert-circle-outline" size={64} color="#ef4444" />
          <Text style={styles.errorTitle}>Error</Text>
          <Text style={styles.errorSubtitle}>{error}</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={() => fetchMemberLocations()}
          >
            <Text style={styles.retryBtnText}>Retry</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Count active/SOS members
  const activeCount = members.filter((m) => m.status === "ACTIVE").length;
  const sosCount = members.filter((m) => m.status === "SOS").length;
  const offlineCount = members.filter((m) => m.status === "OFFLINE" || !m.status).length;

  return (
    <View style={styles.container}>
      {/* Header */}
      <SafeAreaView style={styles.header} edges={["top"]}>
        <TouchableOpacity onPress={openDrawer} style={styles.menuBtn}>
          <Ionicons name="menu" size={28} color="#e5e7eb" />
        </TouchableOpacity>

        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>WORK FLEET</Text>
          <Text style={styles.headerSubtitle}>
            {memberCount} member{memberCount !== 1 ? "s" : ""}
          </Text>
        </View>

        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={() => fetchMemberLocations(true)}
          disabled={refreshing}
        >
          {refreshing ? (
            <ActivityIndicator size="small" color="#22c55e" />
          ) : (
            <Ionicons name="refresh-outline" size={22} color="#e5e7eb" />
          )}
        </TouchableOpacity>
      </SafeAreaView>

      <ScrollView
        style={styles.listContainer}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => fetchMemberLocations(true)}
            tintColor="#22c55e"
            colors={["#22c55e"]}
          />
        }
      >
        {/* Stats Row */}
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: "#22c55e" }]}>{activeCount}</Text>
            <Text style={styles.statLabel}>ACTIVE</Text>
          </View>
          {sosCount > 0 && (
            <View style={[styles.statBox, styles.statBoxSOS]}>
              <Text style={[styles.statValue, { color: "#ef4444" }]}>{sosCount}</Text>
              <Text style={[styles.statLabel, { color: "#fca5a5" }]}>SOS</Text>
            </View>
          )}
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: "#6b7280" }]}>{offlineCount}</Text>
            <Text style={styles.statLabel}>OFFLINE</Text>
          </View>
        </View>

        {/* Invite Code Card */}
        <View style={styles.inviteCodeCard}>
          <Text style={styles.inviteCodeLabel}>FLEET INVITE CODE</Text>
          <Text style={styles.inviteCodeValue}>{inviteCode || "—"}</Text>
          <Text style={styles.inviteCodeHint}>
            Share this code with employees to join your Work fleet
          </Text>
        </View>

        {/* SOS Alert Banner */}
        {sosCount > 0 && (
          <View style={styles.sosAlertBanner}>
            <Ionicons name="warning" size={20} color="#ef4444" />
            <Text style={styles.sosAlertText}>
              {sosCount} member{sosCount !== 1 ? "s" : ""} in SOS mode!
            </Text>
          </View>
        )}

        {/* Members list */}
        <Text style={styles.sectionTitle}>Fleet Members</Text>
        {members.length === 0 ? (
          <View style={styles.emptyList}>
            <Ionicons name="people-outline" size={48} color="#475569" />
            <Text style={styles.emptyListText}>No members yet</Text>
            <Text style={styles.emptyListHint}>
              Share your invite code to add team members
            </Text>
          </View>
        ) : (
          members.map((member, index) => renderMemberCard(member, index))
        )}

        {/* Last updated */}
        {lastUpdated && (
          <Text style={styles.listLastUpdated}>
            Last updated: {lastUpdated.toLocaleTimeString()}
          </Text>
        )}

        {/* Info note */}
        <View style={styles.infoNote}>
          <Ionicons name="information-circle-outline" size={16} color="#64748b" />
          <Text style={styles.infoNoteText}>
            Tap on a member's coordinates to open their location in Maps.
            Location updates every 15 seconds.
          </Text>
        </View>

        {/* Blocked Users Section */}
        <TouchableOpacity
          style={styles.blockedSectionHeader}
          onPress={() => setShowBlockedSection(!showBlockedSection)}
          activeOpacity={0.8}
        >
          <View style={styles.blockedHeaderLeft}>
            <Ionicons name="ban-outline" size={18} color="#94a3b8" />
            <Text style={styles.blockedSectionTitle}>
              Blocked Users ({blockedUsers.length})
            </Text>
          </View>
          <Ionicons
            name={showBlockedSection ? "chevron-up" : "chevron-down"}
            size={18}
            color="#64748b"
          />
        </TouchableOpacity>

        {showBlockedSection && (
          <View style={styles.blockedList}>
            {blockedUsers.length === 0 ? (
              <Text style={styles.blockedEmptyText}>No blocked users</Text>
            ) : (
              blockedUsers.map((user, index) => (
                <View key={user.user_id || index} style={styles.blockedUserCard}>
                  <View style={styles.blockedUserInfo}>
                    <Text style={styles.blockedUserName}>
                      {user.display_name || "Unknown User"}
                    </Text>
                    {user.reason && (
                      <Text style={styles.blockedUserReason}>
                        Reason: {user.reason}
                      </Text>
                    )}
                  </View>
                  <TouchableOpacity
                    style={styles.unblockBtn}
                    onPress={() => handleUnblockUser(user)}
                  >
                    <Text style={styles.unblockBtnText}>Unblock</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
  },

  centerContent: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: "#0f172a",
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },

  menuBtn: {
    padding: 8,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.08)",
  },

  headerCenter: {
    alignItems: "center",
  },

  headerTitle: {
    color: "#e2e8f0",
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: 2,
  },

  headerSubtitle: {
    color: "#64748b",
    fontSize: 12,
    marginTop: 2,
  },

  refreshBtn: {
    padding: 8,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.08)",
  },

  // Stats
  statsRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 12,
    marginBottom: 16,
  },

  statBox: {
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 1,
    borderColor: "#1e293b",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: "center",
    minWidth: 80,
  },

  statBoxSOS: {
    borderColor: "rgba(239, 68, 68, 0.5)",
    backgroundColor: "rgba(239, 68, 68, 0.08)",
  },

  statValue: {
    fontSize: 24,
    fontWeight: "900",
  },

  statLabel: {
    color: "#64748b",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
    marginTop: 4,
  },

  // List
  listContainer: {
    flex: 1,
  },

  listContent: {
    padding: 16,
    paddingBottom: 32,
  },

  sectionTitle: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: 12,
    marginTop: 8,
  },

  inviteCodeCard: {
    backgroundColor: "rgba(34, 197, 94, 0.08)",
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.25)",
    borderRadius: 16,
    padding: 16,
    alignItems: "center",
    marginBottom: 16,
  },

  inviteCodeLabel: {
    color: "#64748b",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1.5,
    marginBottom: 6,
  },

  inviteCodeValue: {
    color: "#22c55e",
    fontSize: 24,
    fontWeight: "900",
    letterSpacing: 3,
    marginBottom: 8,
  },

  inviteCodeHint: {
    color: "#64748b",
    fontSize: 12,
    textAlign: "center",
  },

  sosAlertBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: "rgba(239, 68, 68, 0.15)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.4)",
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },

  sosAlertText: {
    color: "#fca5a5",
    fontSize: 14,
    fontWeight: "800",
  },

  memberCard: {
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 1,
    borderColor: "#1e293b",
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },

  memberCardSOS: {
    borderColor: "rgba(239, 68, 68, 0.5)",
    backgroundColor: "rgba(239, 68, 68, 0.08)",
  },

  memberCardSelected: {
    borderColor: "rgba(34, 197, 94, 0.5)",
    backgroundColor: "rgba(34, 197, 94, 0.05)",
  },

  memberHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },

  memberNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  memberName: {
    color: "#e2e8f0",
    fontSize: 16,
    fontWeight: "700",
  },

  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },

  statusText: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.5,
  },

  memberDetails: {
    gap: 6,
  },

  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  detailText: {
    color: "#94a3b8",
    fontSize: 13,
  },

  detailTextLink: {
    color: "#22c55e",
    fontSize: 13,
    textDecorationLine: "underline",
  },

  detailTextMuted: {
    color: "#475569",
    fontSize: 13,
    fontStyle: "italic",
  },

  expandedActions: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#1e293b",
  },

  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(34, 197, 94, 0.15)",
    borderRadius: 10,
    paddingVertical: 12,
  },

  actionBtnText: {
    color: "#22c55e",
    fontSize: 14,
    fontWeight: "700",
  },

  emptyList: {
    alignItems: "center",
    padding: 40,
  },

  emptyListText: {
    color: "#64748b",
    fontSize: 16,
    fontWeight: "700",
    marginTop: 12,
  },

  emptyListHint: {
    color: "#475569",
    fontSize: 13,
    marginTop: 6,
  },

  listLastUpdated: {
    color: "#475569",
    fontSize: 11,
    textAlign: "center",
    marginTop: 16,
  },

  infoNote: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginTop: 20,
    paddingHorizontal: 4,
  },

  infoNoteText: {
    color: "#64748b",
    fontSize: 12,
    lineHeight: 18,
    flex: 1,
  },

  // Empty/Error states
  emptyTitle: {
    color: "#e2e8f0",
    fontSize: 20,
    fontWeight: "800",
    marginTop: 20,
  },

  emptySubtitle: {
    color: "#64748b",
    fontSize: 14,
    textAlign: "center",
    marginTop: 10,
    lineHeight: 20,
    paddingHorizontal: 20,
  },

  helpBox: {
    marginTop: 30,
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: "#1e293b",
    width: "100%",
  },

  helpTitle: {
    color: "#94a3b8",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 10,
  },

  helpText: {
    color: "#64748b",
    fontSize: 13,
    lineHeight: 22,
  },

  loadingText: {
    color: "#64748b",
    fontSize: 14,
    marginTop: 16,
  },

  errorTitle: {
    color: "#ef4444",
    fontSize: 20,
    fontWeight: "800",
    marginTop: 20,
  },

  errorSubtitle: {
    color: "#64748b",
    fontSize: 14,
    textAlign: "center",
    marginTop: 10,
  },

  retryBtn: {
    marginTop: 20,
    backgroundColor: "#22c55e",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },

  retryBtnText: {
    color: "#0b1220",
    fontSize: 14,
    fontWeight: "800",
  },

  // Block button
  blockBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "rgba(239, 68, 68, 0.10)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.3)",
    borderRadius: 10,
    paddingVertical: 12,
    marginTop: 8,
  },

  blockBtnText: {
    color: "#ef4444",
    fontSize: 14,
    fontWeight: "700",
  },

  // Blocked users section
  blockedSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(255,255,255,0.03)",
    borderWidth: 1,
    borderColor: "#1e293b",
    borderRadius: 12,
    padding: 14,
    marginTop: 24,
  },

  blockedHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  blockedSectionTitle: {
    color: "#94a3b8",
    fontSize: 14,
    fontWeight: "700",
  },

  blockedList: {
    marginTop: 8,
  },

  blockedEmptyText: {
    color: "#475569",
    fontSize: 13,
    textAlign: "center",
    padding: 16,
    fontStyle: "italic",
  },

  blockedUserCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(239, 68, 68, 0.05)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.15)",
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },

  blockedUserInfo: {
    flex: 1,
  },

  blockedUserName: {
    color: "#e2e8f0",
    fontSize: 14,
    fontWeight: "600",
  },

  blockedUserReason: {
    color: "#64748b",
    fontSize: 12,
    marginTop: 2,
  },

  unblockBtn: {
    backgroundColor: "rgba(34, 197, 94, 0.15)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },

  unblockBtnText: {
    color: "#22c55e",
    fontSize: 12,
    fontWeight: "700",
  },
});
