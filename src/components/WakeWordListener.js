// 📂 FILE: src/components/WakeWordListener.js
import { useEffect, useRef, useCallback } from "react";
import { AppState, Platform, PermissionsAndroid } from "react-native";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";

// ============================================
// CONFIGURATION
// ============================================

// Wake phrases to detect (lowercase for matching)
// IMPORTANT: Only full phrases trigger - single words like "sick" or "bathroom" do NOT trigger
const WAKE_PHRASES = [
  "i'm feeling sick",
  "where's the bathroom",
  "please stop",
  "it might rain today",
];

// Fuzzy matching threshold (0-1, lower = more strict)
const FUZZY_THRESHOLD = 0.75;

// Restart delay after recognition ends (ms)
const RESTART_DELAY = 300;

// ============================================
// FUZZY MATCHING UTILITIES
// ============================================

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(str1, str2) {
  const m = str1.length;
  const n = str2.length;

  // Create distance matrix
  const dp = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  // Initialize base cases
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  // Fill the matrix
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

/**
 * Calculate similarity score between two strings (0-1)
 */
function similarity(str1, str2) {
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const distance = levenshteinDistance(s1, s2);
  const maxLen = Math.max(s1.length, s2.length);

  return 1 - distance / maxLen;
}

/**
 * Extract sliding window phrases of a given word count from transcript
 */
function extractPhrases(words, wordCount) {
  const phrases = [];
  for (let i = 0; i <= words.length - wordCount; i++) {
    phrases.push(words.slice(i, i + wordCount).join(" "));
  }
  return phrases;
}

/**
 * Check if transcript contains any wake phrase (exact or fuzzy match)
 * IMPORTANT: Only FULL phrases trigger - single words do NOT trigger
 * Returns the matched wake phrase or null
 */
function detectWakePhrase(transcript) {
  // Normalize: lowercase, remove punctuation, collapse whitespace
  const normalized = transcript
    .toLowerCase()
    .replace(/['']/g, "'") // normalize apostrophes
    .replace(/[^\w\s']/g, " ") // remove punctuation except apostrophes
    .replace(/\s+/g, " ")
    .trim();

  // First, check for exact substring matches of full phrases
  for (const wakePhrase of WAKE_PHRASES) {
    // Also check without apostrophes for "i'm" -> "im", "where's" -> "wheres"
    const phraseNoApostrophe = wakePhrase.replace(/'/g, "");
    if (normalized.includes(wakePhrase) || normalized.includes(phraseNoApostrophe)) {
      console.log(`✅ Exact phrase match: "${wakePhrase}"`);
      return wakePhrase;
    }
  }

  // Check phonetic/common mishearings of FULL phrases only
  const phoneticMappings = {
    "i'm feeling sick": [
      "im feeling sick",
      "i am feeling sick",
      "i'm feeling sic",
      "i feel sick",
      "i'm feeling ill",
      "i'm feeling seek",
    ],
    "where's the bathroom": [
      "wheres the bathroom",
      "where is the bathroom",
      "where's the restroom",
      "where is the restroom",
      "where's the bath room",
      "where's a bathroom",
      "where is a bathroom",
    ],
    "please stop": [
      "please top",
      "pleas stop",
      "please stap",
      "please stopp",
    ],
    "it might rain today": [
      "it might rain to day",
      "it may rain today",
      "it might rain 2day",
      "it might reign today",
      "it might rain toda",
    ],
  };

  for (const [wakePhrase, variants] of Object.entries(phoneticMappings)) {
    for (const variant of variants) {
      if (normalized.includes(variant)) {
        console.log(`🔍 Phonetic phrase match: "${variant}" -> "${wakePhrase}"`);
        return wakePhrase;
      }
    }
  }

  // Fuzzy match full phrases only (no single-word matching!)
  // Extract words from transcript
  const words = normalized.split(/\s+/).filter((w) => w.length > 0);

  for (const wakePhrase of WAKE_PHRASES) {
    const phraseWords = wakePhrase.replace(/'/g, "").split(/\s+/);
    const phraseWordCount = phraseWords.length;

    // Only check phrases with the same word count (or close to it: -1 to +1)
    for (let windowSize = phraseWordCount - 1; windowSize <= phraseWordCount + 1; windowSize++) {
      if (windowSize < 2) continue; // Never match single words

      const candidatePhrases = extractPhrases(words, windowSize);

      for (const candidate of candidatePhrases) {
        // Compare against phrase without apostrophes for fuzzy matching
        const phraseNoApostrophe = wakePhrase.replace(/'/g, "");
        const score = similarity(candidate, phraseNoApostrophe);

        if (score >= FUZZY_THRESHOLD) {
          console.log(
            `🔍 Fuzzy phrase match: "${candidate}" ~ "${wakePhrase}" (score: ${score.toFixed(2)})`
          );
          return wakePhrase;
        }
      }
    }
  }

  return null;
}

// ============================================
// MAIN COMPONENT
// ============================================

export default function WakeWordListener({ onTrigger, onStatus }) {
  const isListeningRef = useRef(false);
  const isStartingRef = useRef(false);
  const mountedRef = useRef(true);
  const restartTimeoutRef = useRef(null);
  const lastTriggerTimeRef = useRef(0);

  // Debounce triggers to prevent rapid-fire activations
  const TRIGGER_DEBOUNCE_MS = 3000;

  const safeStatus = useCallback(
    (msg) => {
      if (!mountedRef.current) return;
      if (onStatus) onStatus(msg);
    },
    [onStatus]
  );

  const safeTrigger = useCallback(
    (wakeWord) => {
      if (!mountedRef.current) return;

      const now = Date.now();
      if (now - lastTriggerTimeRef.current < TRIGGER_DEBOUNCE_MS) {
        console.log("⏳ Trigger debounced");
        return;
      }

      lastTriggerTimeRef.current = now;
      console.log(`🚨 WAKE WORD TRIGGERED: "${wakeWord}"`);

      if (onTrigger) onTrigger(wakeWord);
      safeStatus(`Detected: "${wakeWord}"`);
    },
    [onTrigger, safeStatus]
  );

  const requestMicPermission = useCallback(async () => {
    if (Platform.OS !== "android") return true;

    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        {
          title: "Microphone Access",
          message: "Needed for wake word detection",
          buttonPositive: "OK",
        }
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  }, []);

  const clearRestartTimeout = useCallback(() => {
    if (restartTimeoutRef.current) {
      clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
  }, []);

  const stopListening = useCallback(async () => {
    clearRestartTimeout();
    isListeningRef.current = false;

    try {
      await ExpoSpeechRecognitionModule.stop();
    } catch (e) {
      // Ignore stop errors
    }
  }, [clearRestartTimeout]);

  const startListening = useCallback(async () => {
    if (!mountedRef.current) return;
    if (isListeningRef.current || isStartingRef.current) return;

    isStartingRef.current = true;
    clearRestartTimeout();

    try {
      // Check permission
      const hasPerm = await requestMicPermission();
      if (!hasPerm) {
        safeStatus("Mic Permission Denied");
        isStartingRef.current = false;
        return;
      }

      // Check if speech recognition is available
      const isAvailable =
        await ExpoSpeechRecognitionModule.isRecognitionAvailable();
      if (!isAvailable) {
        safeStatus("Speech recognition unavailable");
        isStartingRef.current = false;
        return;
      }

      safeStatus("Starting...");

      // Base recognition options
      const baseOptions = {
        lang: "en-US",
        interimResults: true,
        continuous: true,
        maxAlternatives: 3,
        addsPunctuation: false,
        contextualStrings: WAKE_PHRASES,
      };

      // Try on-device recognition first, fall back to online if unavailable
      let started = false;

      // Attempt 1: Try on-device recognition
      try {
        await ExpoSpeechRecognitionModule.start({
          ...baseOptions,
          requiresOnDeviceRecognition: true,
        });
        started = true;
        console.log("🎤 Speech recognition started (on-device)");
      } catch {
        // On-device not available, will try online
      }

      // Attempt 2: Fall back to online recognition
      if (!started) {
        try {
          await ExpoSpeechRecognitionModule.start({
            ...baseOptions,
            requiresOnDeviceRecognition: false,
          });
          started = true;
          console.log("🎤 Speech recognition started (online)");
        } catch {
          // Online also failed, will be handled below
        }
      }

      if (started) {
        isListeningRef.current = true;
        safeStatus("Listening...");
      } else {
        // Both attempts failed - silently schedule restart
        isListeningRef.current = false;
        scheduleRestart();
      }
    } catch {
      // Silently handle errors - just reset state and schedule restart
      isListeningRef.current = false;
      scheduleRestart();
    } finally {
      isStartingRef.current = false;
    }
  }, [clearRestartTimeout, requestMicPermission, safeStatus, scheduleRestart]);

  const scheduleRestart = useCallback(() => {
    if (!mountedRef.current) return;

    clearRestartTimeout();
    isListeningRef.current = false;

    restartTimeoutRef.current = setTimeout(() => {
      if (mountedRef.current) {
        console.log("🔄 Restarting speech recognition...");
        startListening();
      }
    }, RESTART_DELAY);
  }, [clearRestartTimeout, startListening]);

  // Handle speech recognition results
  useSpeechRecognitionEvent("result", (event) => {
    if (!mountedRef.current) return;

    const results = event.results || [];

    for (const result of results) {
      const transcript = result.transcript || "";

      if (transcript.length > 0) {
        console.log(`📝 Heard: "${transcript}" (final: ${result.isFinal})`);

        const matchedPhrase = detectWakePhrase(transcript);
        if (matchedPhrase) {
          safeTrigger(matchedPhrase);
          return;
        }
      }
    }
  });

  // Handle recognition start
  useSpeechRecognitionEvent("start", () => {
    console.log("🎤 Recognition started event");
    isListeningRef.current = true;
    safeStatus("Listening...");
  });

  // Handle recognition end - schedule restart for continuous listening
  useSpeechRecognitionEvent("end", () => {
    console.log("🔚 Recognition ended");
    isListeningRef.current = false;

    // Schedule restart for continuous listening
    if (mountedRef.current) {
      scheduleRestart();
    }
  });

  // Handle ALL errors silently - just schedule a restart
  // Never show errors to user, never log as error - just keep trying
  useSpeechRecognitionEvent("error", () => {
    // Silently schedule restart - user should never know there was an issue
    if (mountedRef.current) {
      scheduleRestart();
    }
  });

  // Handle audio start
  useSpeechRecognitionEvent("audiostart", () => {
    console.log("🔊 Audio capture started");
  });

  // Handle audio end
  useSpeechRecognitionEvent("audioend", () => {
    console.log("🔇 Audio capture ended");
  });

  // Setup effect
  useEffect(() => {
    mountedRef.current = true;

    // Start listening on mount
    startListening();

    // Handle app state changes
    const appStateSubscription = AppState.addEventListener(
      "change",
      (nextAppState) => {
        if (nextAppState === "active") {
          console.log("📱 App became active, starting listener");
          startListening();
        } else if (nextAppState.match(/inactive|background/)) {
          console.log("📱 App going to background, stopping listener");
          stopListening();
        }
      }
    );

    return () => {
      mountedRef.current = false;
      clearRestartTimeout();
      appStateSubscription.remove();
      stopListening();
    };
  }, [startListening, stopListening, clearRestartTimeout]);

  return null;
}
