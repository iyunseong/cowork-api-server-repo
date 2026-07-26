"use strict";

/**
 * Express wiring for the KTX booking mini-app.
 *
 *   GET  /ktx                      -> mobile web app (static)
 *   GET  /api/ktx/health           -> python/helper availability
 *   POST /api/ktx/search           -> one-off train search
 *   POST /api/ktx/macro            -> start a background reserve macro
 *   GET  /api/ktx/macro/:id        -> job status (poll from phone)
 *   POST /api/ktx/macro/:id/stop   -> stop a running job
 *
 * Credentials arrive in the POST body, are forwarded to the helper via env,
 * and are never logged. (The app-wide logger only prints req.query.)
 */

const express = require("express");
const path = require("path");
const { runKtx, buildSearchArgs, TRAIN_TYPES, SEAT_OPTIONS, PYTHON } = require("./service");
const macro = require("./macro");

const DATE_RE = /^\d{8}$/;
const TIME_RE = /^\d{6}$/;

function normalizeTime(raw) {
  if (raw == null) return null;
  let t = String(raw).replace(/[^\d]/g, "");
  if (t.length === 4) t += "00"; // HHMM -> HHMMSS
  return t;
}

function validateCreds(body) {
  const id = body && body.id;
  const password = body && body.password;
  if (!id || !password) return { error: "코레일 아이디와 비밀번호를 입력하세요." };
  return { creds: { id: String(id), password: String(password) } };
}

function validateTrip(body) {
  const dep = body && body.dep && String(body.dep).trim();
  const arr = body && body.arr && String(body.arr).trim();
  const date = body && String(body.date || "").trim();
  const time = normalizeTime(body && body.time);

  if (!dep || !arr) return { error: "출발역과 도착역을 입력하세요." };
  if (!DATE_RE.test(date)) return { error: "날짜는 YYYYMMDD 형식(예: 20260801)이어야 합니다." };
  if (!time || !TIME_RE.test(time)) return { error: "시간은 HHMM 또는 HHMMSS 형식이어야 합니다." };

  const trainType = (body.trainType && String(body.trainType)) || "ktx";
  if (!TRAIN_TYPES.has(trainType)) return { error: `지원하지 않는 열차 종류: ${trainType}` };

  const toInt = (v, d) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };

  return {
    trip: {
      dep,
      arr,
      date,
      time,
      trainType,
      adults: toInt(body.adults, 1),
      children: toInt(body.children, 0),
      toddlers: toInt(body.toddlers, 0),
      seniors: toInt(body.seniors, 0),
      includeWaitingList: !!body.includeWaitingList,
    },
  };
}

function register(app) {
  // Serve the mobile web app.
  app.use("/ktx", express.static(path.join(__dirname, "public")));

  const api = express.Router();

  api.get("/health", async (_req, res) => {
    const result = await runKtx(["--help"], null, { timeoutMs: 15000 });
    // argparse prints help to stdout and exits 0; a spawn/ENOENT error means
    // python itself is missing.
    const pythonOk = result.ok || (result.code !== -1);
    res.send({
      python: PYTHON,
      pythonAvailable: pythonOk,
      note: pythonOk
        ? "헬퍼 실행 가능. 코레일 패키지(korail2-ncard, pycryptodome)는 조회/예약 시 필요합니다."
        : result.error,
    });
  });

  api.post("/search", async (req, res) => {
    const c = validateCreds(req.body);
    if (c.error) return res.status(400).send({ error: c.error });
    const t = validateTrip(req.body);
    if (t.error) return res.status(400).send({ error: t.error });

    const trip = Object.assign({}, t.trip, {
      limit: Math.min(20, parseInt(req.body.limit, 10) || 8),
      includeNoSeats: !!req.body.includeNoSeats,
    });
    const result = await runKtx(buildSearchArgs(trip), c.creds, { timeoutMs: 60000 });
    if (!result.ok) return res.status(502).send({ error: result.error });
    res.send(result.data);
  });

  api.post("/macro", (req, res) => {
    const c = validateCreds(req.body);
    if (c.error) return res.status(400).send({ error: c.error });
    const t = validateTrip(req.body);
    if (t.error) return res.status(400).send({ error: t.error });

    const seatOption = (req.body.seatOption && String(req.body.seatOption)) || "general-first";
    if (!SEAT_OPTIONS.has(seatOption)) {
      return res.status(400).send({ error: `지원하지 않는 좌석 옵션: ${seatOption}` });
    }

    // Guardrails: keep polling gentle (skill warns against aggressive polling).
    const intervalSec = Math.min(300, Math.max(10, parseInt(req.body.intervalSec, 10) || 15));
    const maxMinutes = Math.min(720, Math.max(1, parseInt(req.body.maxMinutes, 10) || 60));

    const job = macro.startJob({
      creds: c.creds,
      trip: t.trip,
      trainId: req.body.trainId ? String(req.body.trainId) : null,
      options: {
        seatOption,
        tryWaiting: !!req.body.tryWaiting,
        intervalMs: intervalSec * 1000,
        deadlineMs: Date.now() + maxMinutes * 60 * 1000,
      },
    });
    res.send(job);
  });

  api.get("/macro/:id", (req, res) => {
    const job = macro.getJob(req.params.id);
    if (!job) return res.status(404).send({ error: "해당 작업을 찾을 수 없습니다(만료되었을 수 있음)." });
    res.send(job);
  });

  api.post("/macro/:id/stop", (req, res) => {
    const job = macro.stopJob(req.params.id);
    if (!job) return res.status(404).send({ error: "해당 작업을 찾을 수 없습니다." });
    res.send(job);
  });

  app.use("/api/ktx", api);
}

module.exports = { register };
