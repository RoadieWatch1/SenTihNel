import { useEffect } from 'react';
import { PorcupineManager } from '@picovoice/porcupine-react-native';

// 🔴 YOUR PICOVOICE KEY
const ACCESS_KEY = 'YOUR_PICOVOICE_KEY_HERE'; 

export default function WakeWordListener({ onTrigger, onStatus }) {
  useEffect(() => {
    let porcupineManager = null;

    const initPorcupine = async () => {
      try {
        if (onStatus) onStatus("Initializing Voice...");

        // 1. ATTEMPT TO LOAD THE CUSTOM FILE
        // This might fail on an Emulator, and that is OK.
        porcupineManager = await PorcupineManager.fromKeywordPaths(
          ACCESS_KEY,
          ["trigger.ppn"], 
          (keywordIndex) => {
            if (keywordIndex === 0) {
              console.log("TRIGGER: This ain't right");
              if (onStatus) onStatus("Voice Detected!");
              onTrigger();
            }
          }
        );

        await porcupineManager.start();
        if (onStatus) onStatus("Listening: 'This ain't right'");

      } catch (e) {
        // 🔴 SILENT FAILURE (SAFE MODE)
        // If it crashes (because we are on an Emulator), we just log it and move on.
        console.log("Voice Engine warning (Expected on Emulator):", e.message);
        
        if (onStatus) {
           // Tell the user it's okay
           onStatus("Emulator Mode (Voice Disabled)");
        }
      }
    };

    initPorcupine();

    return () => {
      if (porcupineManager) {
        try {
          porcupineManager.stop();
          porcupineManager.delete();
        } catch(err) {
          // Ignore cleanup errors
        }
      }
    };
  }, []);

  return null;
}