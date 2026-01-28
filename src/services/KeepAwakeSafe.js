// 📂 FILE: src/services/KeepAwakeSafe.js
import { AppState, Platform } from "react-native";

let KeepAwake = null;
function getKeepAwake() {
  if (KeepAwake) return KeepAwake;
  try {
    // eslint-disable-next-line no-eval
    const req = eval("require");
    KeepAwake = req("expo-keep-awake");
    return KeepAwake;
  } catch {
    return null;
  }
}

const TAG = "sentihnel";

export async function safeActivateKeepAwake() {
  // Only makes sense in foreground
  if (AppState.currentState !== "active") return { ok: false, reason: "not_active" };

  const mod = getKeepAwake();

  // If module isn't installed in this build, NEVER crash
  if (!mod?.activateKeepAwakeAsync && !mod?.activateKeepAwake) {
    console.log("🟡 KeepAwake unavailable (module missing in build) — skipping");
    return { ok: false, reason: "module_missing" };
  }

  try {
    if (mod.activateKeepAwakeAsync) await mod.activateKeepAwakeAsync(TAG);
    else mod.activateKeepAwake(TAG);
    return { ok: true };
  } catch (e) {
    console.log("🟡 KeepAwake failed — skipping:", e?.message || e);
    return { ok: false, reason: e?.message || String(e) };
  }
}

export async function safeDeactivateKeepAwake() {
  const mod = getKeepAwake();
  if (!mod?.deactivateKeepAwakeAsync && !mod?.deactivateKeepAwake) return { ok: false };

  try {
    if (mod.deactivateKeepAwakeAsync) await mod.deactivateKeepAwakeAsync(TAG);
    else mod.deactivateKeepAwake(TAG);
    return { ok: true };
  } catch (e) {
    console.log("🟡 KeepAwake deactivate failed:", e?.message || e);
    return { ok: false };
  }
}
