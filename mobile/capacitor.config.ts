import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.kskill.ktxmacro",
  appName: "KTX 자동예매",
  webDir: "www",
  plugins: {
    // Route requests through native HTTP so Korail calls aren't blocked by the
    // WebView's CORS policy, and so session cookies persist across calls.
    CapacitorHttp: { enabled: true },
    CapacitorCookies: { enabled: true },
  },
  android: {
    // Korail responds with JSON under non-JSON content types; allow parsing.
    allowMixedContent: false,
  },
};

export default config;
