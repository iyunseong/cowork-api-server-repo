// DynaPath anti-bot token generator.
//
// Ported 1:1 from the Python `DynaPathMasterEngine` in the k-skill
// ktx-booking helper (ktx/ktx_booking.py). Korail's mobile API rejects
// requests that lack a valid `x-dynapath-m-token`; this reproduces the
// token the official app sends. Pure integer/string math, no crypto.
//
// Parity with the Python reference is verified in mobile/test/parity.test.js.

const TABLE = "3FE9jgRD4KdCyuawklqGJYmvfMn15P7US8XbxeLQtWT6OicBAopINs2Vh0HZrz";
const I8 = 161;
const I9 = 30;
const I10 = 2;

const APP_ID = "com.korail.talk";
const AS_VALUE = "%5B38ff229cb34c7dda8e28220a2d750cce%5D";
const DEVICE_MODEL = "SM-S928N";
const OS_TYPE = "Android";
const SDK_VERSION = "v1.0.3";

function string2xa1s(data) {
  const result = [];
  for (let idx = 0; idx < data.length; idx++) {
    const cp = data.charCodeAt(idx);
    if (cp < 128) {
      result.push(cp);
    } else if (cp < 2048) {
      result.push(128 | ((cp >> 7) & 15));
      result.push(cp & 127);
    } else if (cp >= 262144) {
      result.push(160);
      result.push((cp >> 14) & 127);
      result.push((cp >> 7) & 127);
      result.push(cp & 127);
    } else if ((63488 & cp) !== 55296) {
      result.push(((cp >> 14) & 15) | 144);
      result.push((cp >> 7) & 127);
      result.push(cp & 127);
    }
  }
  return result;
}

function makeKey(key) {
  let total = 0n;
  for (let i = 0; i < key.length; i++) {
    const cp = key.charCodeAt(i);
    let bit = 32768;
    for (let j = 0; j < 16; j++) {
      if (bit & cp) break;
      bit >>= 1;
    }
    total = total * BigInt(bit << 1) + BigInt(cp);
  }
  return total;
}

function internalChar(baseTable, remainder, current) {
  let seen = 0;
  for (const ch of baseTable) {
    if (current.indexOf(ch) !== -1) continue;
    if (seen === remainder) return ch;
    seen += 1;
  }
  return " ";
}

function makeEncodeTable(number, encodeSize, baseTable) {
  let chars = "";
  let temp = number; // BigInt
  for (let index = 0; index < encodeSize; index++) {
    const divisor = BigInt(encodeSize - index);
    const remainder = Number(temp % divisor);
    chars += internalChar(baseTable, remainder, chars);
    temp = temp / divisor;
  }
  return chars;
}

function encodeNormalBE(data, table) {
  const values = string2xa1s(data);
  const output = [];
  const digits = [0, 0, 0]; // I10 + 1
  let idx = 0;
  let tail = values.length % I10;
  const bodySize = values.length - tail;

  while (idx < bodySize) {
    let value = 0;
    for (let k = 0; k < I10; k++) {
      value = value * I8 + values[idx];
      idx += 1;
    }
    for (let di = 0; di < I10 + 1; di++) {
      digits[di] = value % I9;
      value = Math.floor(value / I9);
    }
    for (let di = I10; di >= 0; di--) {
      output.push(table[digits[di]]);
    }
  }

  if (tail > 0) {
    let value = 0;
    for (let k = 0; k < tail; k++) {
      value = value * I8 + values[idx];
      idx += 1;
    }
    for (let di = 0; di < tail + 1; di++) {
      digits[di] = value % I9;
      value = Math.floor(value / I9);
    }
    let t = tail;
    while (t >= 0) {
      output.push(table[digits[t]]);
      t -= 1;
    }
  }

  return output.join("");
}

// SDK v1.0.3 (코레일+ 7.0.x). Korail stopped accepting the older "v1" tokens
// after the 2026-09 코레일+ migration: the SDK version is part of the key
// material and the token now carries the recent request-interval history
// (`rt`, up to 5 entries, newest last). Field layout per the 7.0.8 app
// (cross-checked against pykorail 0.2.0 / korail-mobile-api 2.3.0).
const RT_HISTORY = 5;

export class DynaPath {
  // appStartTs mirrors the SDK init time (`it`); one instance = one app run.
  constructor(appStartTs, { osVersion = "13", deviceModel = DEVICE_MODEL } = {}) {
    this.appStartTs = String(appStartTs);
    this.lastTs = Number(appStartTs);
    this.intervals = [];
    this.osVersion = osVersion;
    this.deviceModel = deviceModel;
  }

  // Like the SDK: record the interval since the previous token, then sign.
  generateToken(deviceId, timestampMs, nonce) {
    this.intervals.push(timestampMs - this.lastTs);
    if (this.intervals.length > RT_HISTORY) this.intervals.shift();
    this.lastTs = timestampMs;
    return this.tokenFor(deviceId, timestampMs, nonce, this.intervals);
  }

  // Pure variant (no history mutation); used by the parity tests.
  tokenFor(deviceId, timestampMs, nonce, intervals = []) {
    const rt = intervals.map((d) => `&rt=${d}`).join("");
    const plaintext =
      `ai=${APP_ID}&di=${deviceId}&as=${AS_VALUE}&su=false&dbg=false&emu=false&hk=false` +
      `&it=${this.appStartTs}&ts=${timestampMs}${rt}&os=${this.osVersion}&dm=${this.deviceModel}&st=${OS_TYPE}&sv=${SDK_VERSION}`;
    const dynKey = `${SDK_VERSION}+${nonce}+${timestampMs}`;
    const keyEncoded = encodeNormalBE(dynKey, TABLE);
    const table2 = makeEncodeTable(makeKey(dynKey), I9, TABLE);
    const bodyEncoded = encodeNormalBE(plaintext, table2);
    return `bEeEP${TABLE[keyEncoded.length]}${keyEncoded}${bodyEncoded}`;
  }
}

// Exported for parity tests.
export const _internal = { string2xa1s, makeKey, makeEncodeTable, encodeNormalBE, TABLE };
