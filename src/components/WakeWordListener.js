import { useEffect } from 'react';
import { AppState } from 'react-native';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

// The phrases to listen for
const WAKE_PHRASES = [
  "this ain't right",
  "help me",
  "oh god",
  "what's going on"
];

export default function WakeWordListener({ onTrigger, onStatus }) {

  useSpeechRecognitionEvent('result', (event) => {
    if (event.results && event.results.length > 0) {
      const latestResult = event.results[event.results.length - 1];
      if (latestResult && latestResult.length > 0) {
        const transcript = latestResult[0].transcript.toLowerCase();
        console.log("Recognized speech:", transcript); // Added for debugging
        const foundWakeWord = WAKE_PHRASES.some(phrase => transcript.includes(phrase));

        if (foundWakeWord) {
          console.log("Wake word detected!"); // Added for debugging
          if (onStatus) onStatus("Voice Detected!");
          onTrigger();
        }
      }
    }
  });

  useSpeechRecognitionEvent('error', (event) => {
    console.error('Speech recognition error:', event);
    if (onStatus) onStatus("Voice Error");
  });

  useSpeechRecognitionEvent('end', () => {
    if (onStatus) onStatus("Voice Ended");
    // Restart listening if the app is still in the foreground
    if (AppState.currentState === 'active') {
      startListening();
    }
  });

  const startListening = async () => {
    try {
      const available = await ExpoSpeechRecognitionModule.isAvailable();
      if (!available) {
        if (onStatus) onStatus("Voice Not Available");
        return;
      }
      const hasPermission = await ExpoSpeechRecognitionModule.requestPermissions();
      if (!hasPermission) {
        if (onStatus) onStatus("Voice Permission Denied");
        return;
      }
      if (onStatus) onStatus("Initializing Voice...");
      await ExpoSpeechRecognitionModule.start({
        lang: 'en-US',
        continuous: true, // Keep listening
        interimResults: true, // Get results as they come
      });
      if (onStatus) onStatus(`Listening...`);
    } catch (e) {
      console.log("Speech Recognition warning:", e.message);
      if (onStatus) onStatus("Voice Disabled");
    }
  };

  useEffect(() => {
    startListening();

    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState === 'active') {
        startListening();
      } else {
        ExpoSpeechRecognitionModule.stop();
      }
    });

    return () => {
      ExpoSpeechRecognitionModule.stop();
      subscription.remove();
    };
  }, []);

  return null;
}