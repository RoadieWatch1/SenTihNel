const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Add 'ppn' (for the wake word) AND 'pv' (for the model params)
config.resolver.assetExts.push('ppn');
config.resolver.assetExts.push('pv'); // <--- YOU WERE MISSING THIS

module.exports = config;