// Expo Config Plugin: withFloatingSOSButton
// Injects the native Android FloatingSOSButton module into EAS builds.
// - Adds SYSTEM_ALERT_WINDOW + FOREGROUND_SERVICE_SPECIAL_USE permissions
// - Declares FloatingSOSService in AndroidManifest.xml
// - Copies Kotlin source files into the android project
// - Copies the ic_floating_sos drawable
// - Registers FloatingSOSPackage in MainApplication.kt

const {
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

const NATIVE_DIR = path.resolve(__dirname, "floating-sos-native");

// ── 1. AndroidManifest: permissions + service declaration ──────────────
function withFloatingSOSManifest(config) {
  return withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;

    // — Add permissions —
    if (!manifest["uses-permission"]) manifest["uses-permission"] = [];
    const perms = manifest["uses-permission"];

    const requiredPerms = [
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
    ];
    for (const perm of requiredPerms) {
      const exists = perms.some(
        (p) => p.$?.["android:name"] === perm
      );
      if (!exists) {
        perms.push({ $: { "android:name": perm } });
      }
    }

    // — Add service declaration inside <application> —
    const app = manifest.application?.[0];
    if (app) {
      if (!app.service) app.service = [];

      const svcName = ".FloatingSOSService";
      const exists = app.service.some(
        (s) => s.$?.["android:name"] === svcName
      );
      if (!exists) {
        app.service.push({
          $: {
            "android:name": svcName,
            "android:exported": "false",
            "android:foregroundServiceType": "specialUse",
          },
          property: [
            {
              $: {
                "android:name":
                  "android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE",
                "android:value":
                  "Floating quick-access button for emergency safety features",
              },
            },
          ],
        });
      }
    }

    return mod;
  });
}

// ── 2. Copy Kotlin files + drawable into generated android project ─────
function withFloatingSOSNativeFiles(config) {
  return withDangerousMod(config, [
    "android",
    (mod) => {
      const projectRoot = mod.modRequest.projectRoot;
      const androidRoot = path.join(projectRoot, "android");

      // Kotlin source destination
      const kotlinDest = path.join(
        androidRoot,
        "app",
        "src",
        "main",
        "java",
        "com",
        "vizir",
        "sentihnel"
      );

      // Ensure directory exists
      fs.mkdirSync(kotlinDest, { recursive: true });

      // Copy Kotlin files
      const ktFiles = [
        "FloatingSOSModule.kt",
        "FloatingSOSService.kt",
        "FloatingSOSPackage.kt",
      ];
      for (const file of ktFiles) {
        const src = path.join(NATIVE_DIR, file);
        const dest = path.join(kotlinDest, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
        }
      }

      // Copy drawable
      const drawableDest = path.join(
        androidRoot,
        "app",
        "src",
        "main",
        "res",
        "drawable"
      );
      fs.mkdirSync(drawableDest, { recursive: true });

      const drawableSrc = path.join(NATIVE_DIR, "ic_floating_sos.xml");
      if (fs.existsSync(drawableSrc)) {
        fs.copyFileSync(
          drawableSrc,
          path.join(drawableDest, "ic_floating_sos.xml")
        );
      }

      return mod;
    },
  ]);
}

// ── 3. Register FloatingSOSPackage in MainApplication.kt ───────────────
function withFloatingSOSMainApplication(config) {
  return withMainApplication(config, (mod) => {
    let contents = mod.modResults.contents;

    // Only add if not already present
    if (!contents.includes("FloatingSOSPackage")) {
      // Insert `add(FloatingSOSPackage())` into the getPackages() block
      // Look for the packages.apply { block
      const applyPattern = /PackageList\(this\)\.packages\.apply\s*\{/;
      if (applyPattern.test(contents)) {
        contents = contents.replace(
          applyPattern,
          `PackageList(this).packages.apply {\n              add(FloatingSOSPackage())`
        );
      } else {
        // Fallback: look for the standard PackageList line and wrap it
        const pkgListPattern =
          /override fun getPackages\(\): List<ReactPackage>\s*=\s*\n\s*PackageList\(this\)\.packages/;
        if (pkgListPattern.test(contents)) {
          contents = contents.replace(
            /PackageList\(this\)\.packages/,
            `PackageList(this).packages.apply {\n              add(FloatingSOSPackage())\n            }`
          );
        }
      }
    }

    mod.modResults.contents = contents;
    return mod;
  });
}

// ── Combine all mods ───────────────────────────────────────────────────
function withFloatingSOSButton(config) {
  config = withFloatingSOSManifest(config);
  config = withFloatingSOSNativeFiles(config);
  config = withFloatingSOSMainApplication(config);
  return config;
}

module.exports = withFloatingSOSButton;
