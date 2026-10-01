// Byte-for-byte parity between the JS Korail port and the Python references
// (korail-mobile-api for the 코레일+ 7.0.8 protocol, korail2 for train ids).
// Requires: pip install korail2-ncard pycryptodome korail-mobile-api.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DynaPath } from "../src/korail/dynapath.js";
import { generateSid, encryptPassword, encryptPasswordLegacy } from "../src/korail/crypto.js";

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(execFileSync("python3", [join(here, "reference.py")], { encoding: "utf-8" }));
const i = ref.inputs;

test("DynaPath v1.0.3 token (with rt history) matches korail-mobile-api", () => {
  const dp = new DynaPath(i.appStartTs);
  assert.equal(dp.tokenFor(i.deviceId, i.timestampMs, i.nonce, ref.rtIntervals), ref.token);
  // generateToken records the interval since the previous token (SDK behaviour)
  const live = new DynaPath(i.appStartTs);
  const start = Number(i.appStartTs);
  const t1 = live.generateToken(i.deviceId, start + 600000, i.nonce);
  assert.deepEqual(live.intervals, [600000]);
  assert.equal(t1, live.tokenFor(i.deviceId, start + 600000, i.nonce, [600000]));
  for (let k = 0; k < 7; k++) live.generateToken(i.deviceId, start + 700000 + k, i.nonce);
  assert.equal(live.intervals.length, 5);
});

test("Sid matches Python", async () => {
  const sid = await generateSid(i.timestampMs, i.device, i.sidKey);
  assert.equal(sid, ref.sid);
});

test("login password encoding matches the app (korail-mobile-api) and the legacy korail2 form", async () => {
  assert.equal(await encryptPassword(i.password, i.loginKey), ref.encPasswordApp);
  assert.equal(await encryptPasswordLegacy(i.password, i.loginKey), ref.encPassword);
});
