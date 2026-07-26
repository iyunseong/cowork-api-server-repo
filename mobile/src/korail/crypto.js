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

// Login password encryption. Python __enc_password: fetch {idx, key} from
// KORAIL_CODE, then base64(base64(AES-CBC(key=key, iv=key[:16]).encrypt(pad(pw)))).
export async function encryptPassword(password, key) {
  const keyBytes = encoder.encode(key);
  const ivBytes = encoder.encode(key.slice(0, 16));
  const ct = await aesCbcEncrypt(keyBytes, ivBytes, encoder.encode(password));
  const inner = bytesToBase64(ct); // first base64 (ASCII string)
  return btoa(inner); // second base64 over the ASCII bytes of the first
}
