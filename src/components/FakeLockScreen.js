import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Dimensions, Vibration } from 'react-native';
import { Ionicons } from '@expo/vector-icons'; // For the backspace icon

const { width } = Dimensions.get('window');

// 🔴 THE SECRET CODE TO EXIT PANIC MODE
const MASTER_CODE = "1337"; 

export default function FakeLockScreen({ onUnlock }) {
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState("Enter PIN");
  const [attempts, setAttempts] = useState(0);

  const handlePress = (num) => {
    if (pin.length < 4) {
      const newPin = pin + num;
      setPin(newPin);
      
      // Check immediately when 4 digits are entered
      if (newPin.length === 4) {
        verifyPin(newPin);
      }
    }
  };

  const handleBackspace = () => {
    setPin(pin.slice(0, -1));
  };

  const verifyPin = (inputPin) => {
    if (inputPin === MASTER_CODE) {
      // ✅ SUCCESS: Disarm the system
      onUnlock(); 
    } else {
      // ❌ FAILURE: Fake the error
      Vibration.vibrate(400); // Shake the phone physically
      setMessage("Incorrect PIN");
      setPin(""); // Clear dots
      setAttempts(attempts + 1);

      // Psychological trick: After 3 fails, simulate a lockout
      if (attempts >= 2) {
        setMessage("Try again in 30 seconds");
        // (In reality, they can keep typing, but it scares them)
      } else {
        setTimeout(() => setMessage("Enter PIN"), 2000);
      }
    }
  };

  // Render the 4 dots
  const renderDots = () => (
    <View style={styles.dotContainer}>
      {[...Array(4)].map((_, i) => (
        <View key={i} style={[styles.dot, i < pin.length && styles.filledDot]} />
      ))}
    </View>
  );

  // Render a single number key
  const renderKey = (num) => (
    <TouchableOpacity key={num} onPress={() => handlePress(num)} style={styles.key}>
      <Text style={styles.keyText}>{num}</Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Top Section: Message & Dots */}
      <View style={styles.displayArea}>
        <Text style={styles.message}>{message}</Text>
        {renderDots()}
      </View>

      {/* Bottom Section: Keypad */}
      <View style={styles.keypad}>
        <View style={styles.row}>{[1, 2, 3].map(renderKey)}</View>
        <View style={styles.row}>{[4, 5, 6].map(renderKey)}</View>
        <View style={styles.row}>{[7, 8, 9].map(renderKey)}</View>
        <View style={styles.row}>
          <View style={styles.emptyKey} />
          {renderKey(0)}
          <TouchableOpacity onPress={handleBackspace} style={styles.key}>
            <Ionicons name="backspace-outline" size={28} color="white" />
          </TouchableOpacity>
        </View>
      </View>
      
      {/* EMERGENCY HINT (Remove this line after you memorize the code!) */}
      <Text style={styles.hint}> (Dev Hint: Code is {MASTER_CODE}) </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', justifyContent: 'center', alignItems: 'center' },
  displayArea: { alignItems: 'center', marginBottom: 50 },
  message: { color: 'white', fontSize: 20, marginBottom: 20, fontWeight: '500' },
  dotContainer: { flexDirection: 'row', gap: 20 },
  dot: { width: 15, height: 15, borderRadius: 10, borderWidth: 1, borderColor: 'white' },
  filledDot: { backgroundColor: 'white' },
  keypad: { width: width * 0.8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  key: { width: 75, height: 75, borderRadius: 40, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  keyText: { color: 'white', fontSize: 28, fontWeight: '400' },
  emptyKey: { width: 75, height: 75 },
  hint: { color: '#444', marginTop: 20 }
});