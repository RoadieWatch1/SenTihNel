import AsyncStorage from '@react-native-async-storage/async-storage';
// FIX: Import EVERYTHING from legacy to ensure constants and functions match
import * as FileSystem from 'expo-file-system/legacy'; 

const DISGUISE_KEY = 'sentihnel_disguise_path';

// FIX: Use the legacy import for the folder path too
// If documentDirectory is somehow null, we fallback to cacheDirectory to prevent the crash
const rootDir = FileSystem.documentDirectory || FileSystem.cacheDirectory;
const IMAGE_DIR = rootDir + 'disguise/';

async function ensureDirExists() {
  const dirInfo = await FileSystem.getInfoAsync(IMAGE_DIR);
  if (!dirInfo.exists) {
    await FileSystem.makeDirectoryAsync(IMAGE_DIR, { intermediates: true });
  }
}

export async function saveDisguiseImage(tempUri) {
  try {
    if (!rootDir) {
      throw new Error("Could not determine device storage path.");
    }
    
    await ensureDirExists();
    const fileName = 'homescreen_cover.jpg';
    const newPath = IMAGE_DIR + fileName;
    
    await FileSystem.copyAsync({ from: tempUri, to: newPath });
    await AsyncStorage.setItem(DISGUISE_KEY, newPath);
    console.log("✅ Image Saved to:", newPath);
    return newPath;
  } catch (e) {
    console.error("Failed to save disguise:", e);
    throw e;
  }
}

export async function getDisguiseImage() {
  try {
    const path = await AsyncStorage.getItem(DISGUISE_KEY);
    if (!path) return null;
    
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) {
        await AsyncStorage.removeItem(DISGUISE_KEY);
        return null;
    }
    return path;
  } catch (e) {
    return null;
  }
}