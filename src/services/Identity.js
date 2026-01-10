import AsyncStorage from '@react-native-async-storage/async-storage';

const ID_KEY = 'SENTIHNEL_DEVICE_ID';

export const getDeviceId = async () => {
  try {
    // 1. Check if we already have an ID saved
    const existingId = await AsyncStorage.getItem(ID_KEY);
    
    if (existingId !== null) {
      return existingId;
    }

    // 2. If not, generate a random 4-digit code (e.g. 8842)
    const randomCode = Math.floor(1000 + Math.random() * 9000); 
    const newId = `Device-${randomCode}`;
    
    // 3. Save it forever on this phone
    await AsyncStorage.setItem(ID_KEY, newId);
    return newId;
    
  } catch (e) {
    console.error("Error creating ID", e);
    return "Device-0000"; // Fallback
  }
};