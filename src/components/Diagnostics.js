// 📂 FILE: src/components/Diagnostics.js
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Linking,
  Platform,
  AppState,
} from 'react-native';
import * as Location from 'expo-location';
import * as Battery from 'expo-battery';
import * as IntentLauncher from 'expo-intent-launcher';

export default function Diagnostics({ onComplete }) {
  const [status, setStatus] = useState({
    gps: 'pending',        // 'granted' | 'denied' | 'pending'
    background: 'pending', // 'granted' | 'denied' | 'pending'
    battery: 'pending',    // android-only
  });

  const [details, setDetails] = useState({
    gpsCanAskAgain: true,
    bgCanAskAgain: true,
  });

  const [busy, setBusy] = useState(false);

  // ✅ Safe settings opener (works on both platforms)
  const openAppSettings = useCallback(async () => {
    try {
      // RN supports this on iOS + Android in most builds
      await Linking.openSettings();
      return;
    } catch (e) {
      // Fallback (mainly older iOS)
      try {
        await Linking.openURL('app-settings:');
      } catch (_) {}
    }
  }, []);

  // ✅ Check all systems (hardened)
  const checkAll = useCallback(async () => {
    try {
      const fg = await Location.getForegroundPermissionsAsync();
      const bg = await Location.getBackgroundPermissionsAsync();

      let batteryOpt = 'granted';
      if (Platform.OS === 'android') {
        try {
          const isOptimized = await Battery.isBatteryOptimizationEnabledAsync();
          batteryOpt = isOptimized ? 'denied' : 'granted';
        } catch (e) {
          batteryOpt = 'pending';
        }
      } else {
        // iOS: not relevant to battery optimizations in the same way
        batteryOpt = 'granted';
      }

      setStatus({
        gps: fg.status === 'granted' ? 'granted' : 'denied',
        background: bg.status === 'granted' ? 'granted' : 'denied',
        battery: batteryOpt,
      });

      setDetails({
        gpsCanAskAgain: fg.canAskAgain !== false,
        bgCanAskAgain: bg.canAskAgain !== false,
      });
    } catch (e) {
      // Never crash Diagnostics; keep last known state
      setStatus((prev) => ({ ...prev }));
      setDetails((prev) => ({ ...prev }));
    }
  }, []);

  // ✅ Initialize + AppState listener (auto refresh after settings)
  useEffect(() => {
    checkAll();

    const sub = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') checkAll();
    });

    return () => sub?.remove?.();
  }, [checkAll]);

  const fixBattery = useCallback(() => {
    if (Platform.OS !== 'android') return;
    IntentLauncher.startActivityAsync(
      'android.settings.IGNORE_BATTERY_OPTIMIZATION_SETTINGS'
    );
  }, []);

  const fixLocation = useCallback(async () => {
    if (busy) return;
    setBusy(true);

    try {
      // 1) Foreground first
      const fg = await Location.requestForegroundPermissionsAsync();
      if (fg.status !== 'granted') {
        await checkAll();
        return;
      }

      // 2) Samsung/Android 14+ “beat”
      if (Platform.OS === 'android') {
        await new Promise((resolve) => setTimeout(resolve, 650));
      }

      // 3) Background
      await Location.requestBackgroundPermissionsAsync();
    } catch (e) {
      // If something goes wrong, give user a path to recover
      await openAppSettings();
    } finally {
      await checkAll();
      setBusy(false);
    }
  }, [busy, checkAll, openAppSettings]);

  const fixAll = useCallback(async () => {
    // Best-effort: permissions first, then Android battery
    await fixLocation();
    if (Platform.OS === 'android') fixBattery();
  }, [fixLocation, fixBattery]);

  const allClear = useMemo(() => {
    const gpsOk = status.gps === 'granted';
    const bgOk = status.background === 'granted';
    const batteryOk = Platform.OS === 'android' ? status.battery === 'granted' : true;
    return gpsOk && bgOk && batteryOk;
  }, [status]);

  const needsGPSSettings =
    status.gps !== 'granted' && details.gpsCanAskAgain === false;

  const needsBGSettings =
    status.background !== 'granted' && details.bgCanAskAgain === false;

  const needsManualSettings = needsGPSSettings || needsBGSettings;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>System Diagnostics</Text>
      <Text style={styles.subtitle}>
        For emergency reliability, these should be green.
      </Text>

      <DiagnosticRow
        label="GPS Precision"
        status={status.gps}
        desc="Required while the app is open."
        needsSettings={needsGPSSettings}
        onFix={fixLocation}
        onOpenSettings={openAppSettings}
      />

      <DiagnosticRow
        label="Background Access"
        status={status.background}
        desc={
          Platform.OS === 'ios'
            ? "Set Location to 'Always' in Settings for locked-screen tracking."
            : 'Allows tracking when screen is locked.'
        }
        needsSettings={needsBGSettings}
        onFix={fixLocation}
        onOpenSettings={openAppSettings}
      />

      {Platform.OS === 'android' && (
        <DiagnosticRow
          label="Battery Restrictions (Android)"
          status={status.battery}
          desc="Set to Unrestricted so the OS doesn’t pause tracking."
          extraNote="Samsung tip: Settings → Apps → Sentinel → Battery → Unrestricted (and disable Sleeping Apps if needed)."
          onFix={fixBattery}
          onOpenSettings={openAppSettings}
          // battery row doesn’t use canAskAgain; settings path still helpful
          needsSettings={false}
        />
      )}

      {/* Actions */}
      {!allClear && (
        <TouchableOpacity
          style={[styles.btn, styles.btnSecondary, busy && styles.btnDisabled]}
          disabled={busy}
          onPress={fixAll}
        >
          <Text style={styles.btnTextAlt}>{busy ? 'WORKING…' : 'FIX ALL'}</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={[styles.btn, !allClear && styles.btnDisabled]}
        disabled={!allClear || busy}
        onPress={onComplete}
      >
        <Text style={[styles.btnText, (!allClear || busy) && styles.btnTextDisabled]}>
          {allClear ? 'ACTIVATE STEALTH' : 'COMPLETE CHECKLIST ABOVE'}
        </Text>
      </TouchableOpacity>

      {needsManualSettings && (
        <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={openAppSettings}>
          <Text style={styles.btnTextGhost}>OPEN APP SETTINGS</Text>
        </TouchableOpacity>
      )}

      {needsManualSettings && (
        <Text style={styles.footerNote}>
          Some permissions were previously denied. Enable them manually in System Settings.
        </Text>
      )}
    </View>
  );
}

function DiagnosticRow({
  label,
  status,
  onFix,
  desc,
  needsSettings,
  onOpenSettings,
  extraNote,
}) {
  const isOk = status === 'granted';
  const isPending = status === 'pending';

  const icon = isOk ? '✅' : isPending ? '⏳' : '❌';

  return (
    <View style={styles.row}>
      <View style={styles.info}>
        <Text style={styles.label}>
          {label} {icon}
        </Text>

        {!!desc && <Text style={styles.desc}>{desc}</Text>}
        {!!extraNote && <Text style={styles.extra}>{extraNote}</Text>}

        {needsSettings && (
          <Text style={styles.warning}>Action required in Settings</Text>
        )}
      </View>

      {!isOk && (
        <TouchableOpacity
          style={[styles.fixBtn, needsSettings && styles.settingsBtn]}
          onPress={needsSettings ? onOpenSettings : onFix}
        >
          <Text style={styles.fixText}>{needsSettings ? 'SETTINGS' : 'FIX'}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    backgroundColor: '#0b1220',
    borderRadius: 18,
    margin: 10,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  title: { color: '#fff', fontSize: 24, fontWeight: '800' },
  subtitle: { color: '#94a3b8', marginBottom: 18, fontSize: 14, lineHeight: 18 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 18,
    borderBottomWidth: 1,
    borderBottomColor: '#1e293b',
  },
  info: { flex: 1, paddingRight: 10 },
  label: { color: '#f8fafc', fontSize: 16, fontWeight: '800' },
  desc: { color: '#64748b', fontSize: 12, marginTop: 6, lineHeight: 16 },
  extra: { color: '#94a3b8', fontSize: 11, marginTop: 6, lineHeight: 16 },
  warning: { color: '#fbbf24', fontSize: 11, fontWeight: '900', marginTop: 8 },

  fixBtn: {
    backgroundColor: '#ef4444',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
    minWidth: 92,
    alignItems: 'center',
  },
  settingsBtn: { backgroundColor: '#3b82f6' },
  fixText: { color: '#fff', fontWeight: '900', fontSize: 13, letterSpacing: 0.2 },

  btn: {
    backgroundColor: '#22c55e',
    marginTop: 12,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  btnSecondary: { backgroundColor: '#3b82f6' },
  btnGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  btnDisabled: { backgroundColor: '#1e293b' },

  btnText: { color: '#001b0b', fontWeight: '900', fontSize: 16 },
  btnTextDisabled: { color: '#94a3b8' },
  btnTextAlt: { color: '#fff', fontWeight: '900', fontSize: 16 },
  btnTextGhost: { color: '#e5e7eb', fontWeight: '900', fontSize: 14, letterSpacing: 0.3 },

  footerNote: { color: '#64748b', fontSize: 11, textAlign: 'center', marginTop: 12 },
});





