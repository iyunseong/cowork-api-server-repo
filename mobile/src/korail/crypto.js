// Crypto helpers for Korail login, using the Web Crypto API (SubtleCrypto).
// Works unchanged in the Android WebView and in Node 20+ (both expose
// globalThis.crypto.subtle and btoa). AES-CBC uses PKCS#7 padding, matching
// pycryptodome's pad(..., 16) in the Python reference.

const encoder = new TextEncoder();

function bytesToBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function aesCbcEncrypt(keyBytes, ivBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv: ivBytes }, key, dataBytes);
  return new Uint8Array(ct);
}

// Sid header value. Python: base64(AES-CBC(key=iv="2485dd54d9deaa36").encrypt(
// pad("AD" + ts))) + "\n"
export async function generateSid(timestampMs, device = "AD", sidKey = "2485dd54d9deaa36") {
  const keyBytes = encoder.encode(sidKey); // 16 bytes -> AES-128
  const data = encoder.encode(`${device}${timestampMs}`);
  const ct = await aesCbcEncrypt(keyBytes, keyBytes, data);
  return bytesToBase64(ct) + "\n";
}

// Login password encryption, as the 코레일+ app does it (AESCrypto + Android
// Base64): AES-CBC(key=key, iv=key[:16], PKCS#7) → standard base64 (NO_WRAP)
// → URL_SAFE base64 of that ASCII text, wrapped at 76 columns with a trailing
// newline (Android's default wrap mode). Server-issued {idx, key} come from
// common.code.do ("app.login.cphd").
export async function encryptPassword(password, key) {
  const keyBytes = encoder.encode(key);
  const ivBytes = encoder.encode(key.slice(0, 16));
  const ct = await aesCbcEncrypt(keyBytes, ivBytes, encoder.encode(password));
  const inner = bytesToBase64(ct);
  const outer = btoa(inner).replace(/\+/g, "-").replace(/\//g, "_");
  const lines = [];
  for (let i = 0; i < outer.length; i += 76) lines.push(outer.slice(i, i + 76));
  return lines.join("\n") + "\n";
}

// korail2-era variant (double standard base64); kept for the parity test.
export async function encryptPasswordLegacy(password, key) {
  const keyBytes = encoder.encode(key);
  const ivBytes = encoder.encode(key.slice(0, 16));
  const ct = await aesCbcEncrypt(keyBytes, ivBytes, encoder.encode(password));
  return btoa(bytesToBase64(ct));
}
