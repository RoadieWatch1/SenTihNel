import * as Location from 'expo-location';
import { Vibration } from 'react-native';

// 🔴 CONFIGURATION
// Updated to your new professional domain
const GUARDIAN_SITE = 'https://sentihnel.com';
const CLOUD_ROBOT_URL = `${GUARDIAN_SITE}/.netlify/functions/send-sos`;

// 🔴 TEST NUMBER: Put your own cell phone number here to test it!
// Format: +15551234567 (Must include +1)
const GUARDIAN_PHONE_NUMBER = '+14708123029'; 

export const registerForBatSignal = async () => {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') console.error('Location permission denied');
};

export const sendBatSignal = async (deviceId) => {
  console.log("🦇 BAT SIGNAL: ACTIVATING SILENT MODE...");
  Vibration.vibrate([0, 50, 100, 50]); // Tactile confirmation

  try {
    // 1. GET GPS
    // We try to get the location, but if it fails, we default to 0,0 so the link still sends.
    let lat = 0;
    let lng = 0;
    try {
        let location = await Location.getCurrentPositionAsync({});
        lat = location.coords.latitude;
        lng = location.coords.longitude;
    } catch (e) {
        console.log("⚠️ Could not get exact GPS for SMS link, sending link anyway.");
    }

    // 2. GENERATE LINK
    const fullLink = `${GUARDIAN_SITE}?id=${deviceId}&lat=${lat}&lng=${lng}`;
    console.log("🔗 SECRET LINK GENERATED:", fullLink);

    // 3. WAKE UP THE CLOUD ROBOT (Silent Network Request)
    // This attempts to send the SMS via your Netlify function
    const response = await fetch(CLOUD_ROBOT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guardianNumber: GUARDIAN_PHONE_NUMBER,
        messageLink: fullLink,
      }),
    });

    // Safety Check: Ensure we got a real success, not a 404 HTML page
    const contentType = response.headers.get("content-type");
    if (response.ok && contentType && contentType.includes("application/json")) {
      console.log("✅ SILENT SMS SENT SUCCESSFULLY!");
      return true;
    } else {
      // If the function isn't set up yet, we just log the link so you can use it manually
      console.log("⚠️ Cloud Robot Offline (SMS not sent). USE THIS LINK:");
      console.log(fullLink);
      return false;
    }

  } catch (error) {
    console.error("❌ SIGNAL FAILED (Network Error):", error);
    return false;
  }
};