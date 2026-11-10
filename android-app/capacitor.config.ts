import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'corp.edendevs.edengestion.android',
  appName: 'Eden Gestion',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    captureInput: true,
  },
  plugins: {
    CapacitorSQLite: {
      androidIsEncryption: false,
      iosIsEncryption: false,
    },
  },
};

export default config;
