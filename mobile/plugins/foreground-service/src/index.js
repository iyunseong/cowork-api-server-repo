import { registerPlugin } from "@capacitor/core";

// Native plugin (Android). Methods: start({title, body}), update({title, body}),
// stop(). The app also accesses this at runtime via Capacitor.Plugins.ForegroundService.
export const ForegroundService = registerPlugin("ForegroundService");
