// Byte-for-byte parity between the JS Korail port and the Python reference.
// Requires the Python reference deps (pip install korail2-ncard pycryptodome).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { DynaPath } from "../src/korail/dynapath.js";
import { generateSid, encryptPassword } from "../src/korail/crypto.js";

const here = dirname(fileURLToPath(import.meta.url));

function loadReference() {
  const out = execFileSync("python3", [join(here, "reference.py")], { encoding: "utf-8" });
  return JSON.parse(out);
}

const ref = loadReference();
const i = ref.inputs;

test("DynaPath token matches Python", () => {
  const dp = new DynaPath(i.appStartTs);
  const token = dp.generateToken(i.deviceId, i.timestampMs, i.nonce);
  assert.equal(token, ref.token);
});

test("Sid matches Python", async () => {
  const sid = await generateSid(i.timestampMs, i.device, i.sidKey);
  assert.equal(sid, ref.sid);
});

test("enc_password matches Python", async () => {
  const enc = await encryptPassword(i.password, i.loginKey);
  assert.equal(enc, ref.encPassword);
});
