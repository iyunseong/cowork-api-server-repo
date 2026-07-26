"use strict";

/**
 * Thin Node wrapper around ktx/ktx_booking.py.
 *
 * Every call spawns the Python helper as a child process and parses its JSON
 * stdout. Korail credentials are passed via environment variables on the
 * spawned process ONLY (never as argv, so they can't leak into the process
 * list), and are never logged or persisted here.
 */

const { spawn } = require("child_process");
const path = require("path");

const PYTHON = process.env.KTX_PYTHON || process.env.PYTHON || "python3";
const HELPER = path.join(__dirname, "ktx_booking.py");

const TRAIN_TYPES = new Set([
  "ktx",
  "itx-saemaeul",
  "mugunghwa",
  "nuriro",
  "tonggeun",
  "itx-cheongchun",
  "airport",
  "all",
]);
const SEAT_OPTIONS = new Set([
  "general-first",
  "general-only",
  "special-first",
  "special-only",
]);

/**
 * Run the helper with the given subcommand argv.
 * Resolves (never rejects) with a normalized result object:
 *   { ok: true,  code, data }                       on exit 0 + valid JSON
 *   { ok: false, code, error, stderr, stdout }      otherwise
 */
function runKtx(subArgs, creds, options = {}) {
  const timeoutMs = options.timeoutMs || 90000;
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env);
    if (creds && creds.id) env.KSKILL_KTX_ID = String(creds.id);
    if (creds && creds.password) env.KSKILL_KTX_PASSWORD = String(creds.password);

    let child;
    try {
      child = spawn(PYTHON, [HELPER, ...subArgs], { env });
    } catch (err) {
      return resolve({ ok: false, code: -1, error: `python 실행 실패: ${err.message}` });
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      const hint =
        err.code === "ENOENT"
          ? `'${PYTHON}' 실행 파일을 찾을 수 없습니다. Python 3.10+ 를 설치하거나 KTX_PYTHON 환경변수를 지정하세요.`
          : `python 실행 실패: ${err.message}`;
      done({ ok: false, code: -1, error: hint, stderr });
    });
    child.on("close", (code) => {
      if (timedOut) {
        return done({ ok: false, code: -1, error: "요청 시간 초과", stderr });
      }
      if (code === 0) {
        try {
          return done({ ok: true, code, data: JSON.parse(stdout) });
        } catch (e) {
          return done({
            ok: false,
            code,
            error: "헬퍼 응답(JSON) 파싱 실패",
            stderr,
            stdout,
          });
        }
      }
      const message = (stderr.trim() || stdout.trim() || `종료 코드 ${code}`).slice(0, 500);
      done({ ok: false, code, error: message, stderr, stdout });
    });
  });
}

function passengerArgs(trip) {
  const args = [];
  const adults = Number.isInteger(trip.adults) ? trip.adults : 1;
  args.push("--adults", String(Math.max(0, adults)));
  if (trip.children) args.push("--children", String(trip.children));
  if (trip.toddlers) args.push("--toddlers", String(trip.toddlers));
  if (trip.seniors) args.push("--seniors", String(trip.seniors));
  return args;
}

function buildSearchArgs(trip) {
  const args = [
    "search",
    trip.dep,
    trip.arr,
    trip.date,
    trip.time,
    "--limit",
    String(trip.limit || 8),
    "--train-type",
    trip.trainType || "ktx",
  ];
  if (trip.includeNoSeats) args.push("--include-no-seats");
  if (trip.includeWaitingList) args.push("--include-waiting-list");
  return args.concat(passengerArgs(trip));
}

function buildReserveArgs(trip) {
  const args = [
    "reserve",
    trip.dep,
    trip.arr,
    trip.date,
    trip.time,
    "--train-id",
    trip.trainId,
    "--seat-option",
    trip.seatOption || "general-first",
    "--train-type",
    trip.trainType || "ktx",
  ];
  if (trip.includeNoSeats) args.push("--include-no-seats");
  if (trip.includeWaitingList) args.push("--include-waiting-list");
  if (trip.tryWaiting) args.push("--try-waiting");
  return args.concat(passengerArgs(trip));
}

module.exports = {
  runKtx,
  buildSearchArgs,
  buildReserveArgs,
  TRAIN_TYPES,
  SEAT_OPTIONS,
  PYTHON,
  HELPER,
};
