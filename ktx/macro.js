"use strict";

/**
 * In-memory background job manager for the KTX booking macro.
 *
 * A job repeatedly asks the Python helper to reserve a target train until it
 * succeeds, the caller stops it, or a deadline/attempt cap is hit. Reservation
 * stops BEFORE payment (same as the underlying skill).
 *
 * Credentials live only inside the job object in memory for the job's lifetime
 * and are never included in the public status payload.
 */

const crypto = require("crypto");
const { runKtx, buildSearchArgs, buildReserveArgs } = require("./service");

const jobs = new Map();

// Keep finished jobs around briefly so the phone can reconnect and read the
// result, then evict to avoid unbounded growth.
const RETAIN_FINISHED_MS = 30 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function classifyError(message) {
  const s = String(message || "");
  if (/KSKILL_KTX_ID|KSKILL_KTX_PASSWORD|필요합니다/.test(s)) return "config";
  if (/train_id (is invalid|no longer matches)/.test(s)) return "gone";
  if (/로그인|NeedToLogin|login failed/i.test(s)) return "auth";
  // SoldOutError / NoResultsError / transient network → keep retrying.
  return "retry";
}

function publicJob(job) {
  if (!job) return null;
  return {
    jobId: job.id,
    status: job.status, // running | reserved | failed | stopped
    mode: job.mode, // "train" | "auto"
    attempts: job.attempts,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    lastAttemptAt: job.lastAttemptAt,
    lastMessage: job.lastMessage,
    nextAttemptAt: job.nextAttemptAt,
    intervalSec: Math.round(job.intervalMs / 1000),
    trip: {
      dep: job.trip.dep,
      arr: job.trip.arr,
      date: job.trip.date,
      time: job.trip.time,
      trainType: job.trip.trainType,
      seatOption: job.options.seatOption,
    },
    reservation: job.reservation || null,
  };
}

function finish(job, status, message) {
  job.status = status;
  job.finishedAt = Date.now();
  job.nextAttemptAt = null;
  if (message) job.lastMessage = message;
  // Wipe credentials from memory as soon as the job is done.
  job.creds = null;
  scheduleEviction(job);
}

function scheduleEviction(job) {
  setTimeout(() => {
    jobs.delete(job.id);
  }, RETAIN_FINISHED_MS).unref?.();
}

// Sleep that wakes early when the job is stopped, so /stop feels responsive.
async function interruptibleSleep(job, ms) {
  const step = 500;
  let waited = 0;
  job.nextAttemptAt = Date.now() + ms;
  while (waited < ms && job.status === "running") {
    await sleep(Math.min(step, ms - waited));
    waited += step;
  }
  job.nextAttemptAt = null;
}

async function attemptReserve(job, trainId) {
  const trip = Object.assign({}, job.trip, {
    trainId,
    seatOption: job.options.seatOption,
    tryWaiting: job.options.tryWaiting,
    // Include sold-out trains so a full train is reported as SoldOut (retry)
    // rather than "gone" (stop). include waiting list when trying waiting.
    includeNoSeats: true,
    includeWaitingList: job.options.tryWaiting,
  });
  return runKtx(buildReserveArgs(trip), job.creds, { timeoutMs: 90000 });
}

async function runLoop(job) {
  job.status = "running";
  job.startedAt = Date.now();

  // Preflight: the helper prints an EMPTY message for both SoldOutError and
  // NeedToLoginError, so a wrong password is indistinguishable from a sold-out
  // train inside the retry loop. A one-off `reservations` call cleanly
  // validates the login (and dependency install) up front: it exits 0 on a
  // successful login even with zero reservations, and non-zero otherwise.
  const preflight = await runKtx(["reservations"], job.creds, { timeoutMs: 60000 });
  if (job.status !== "running") return; // stopped during preflight
  if (!preflight.ok) {
    if (/Python packages|pip install/i.test(preflight.error || "")) {
      return finish(job, "failed", "서버에 코레일 패키지가 설치되지 않았습니다. requirements.txt 를 설치하세요.");
    }
    return finish(job, "failed", "로그인에 실패했습니다. 아이디/비밀번호를 확인하세요.");
  }

  while (job.status === "running") {
    if (job.options.deadlineMs && Date.now() > job.options.deadlineMs) {
      return finish(job, "failed", "마감 시간을 초과했습니다.");
    }
    if (job.options.maxAttempts && job.attempts >= job.options.maxAttempts) {
      return finish(job, "failed", `최대 시도 횟수(${job.options.maxAttempts}회)에 도달했습니다.`);
    }

    job.attempts += 1;
    job.lastAttemptAt = Date.now();

    let targetTrainId = job.trainId;

    // "auto" mode: find the earliest train that currently has a seat.
    if (job.mode === "auto") {
      const searchTrip = Object.assign({}, job.trip, {
        includeWaitingList: job.options.tryWaiting,
      });
      const searched = await runKtx(buildSearchArgs(searchTrip), job.creds, { timeoutMs: 60000 });
      if (job.status !== "running") break;
      if (!searched.ok) {
        const kind = classifyError(searched.error);
        if (kind === "auth") return finish(job, "failed", "로그인 실패 — 아이디/비밀번호를 확인하세요.");
        if (kind === "config") return finish(job, "failed", "서버 설정 오류(코레일 계정 정보 누락).");
        job.lastMessage = "조건에 맞는 열차가 아직 없습니다. 재시도 중…";
        await interruptibleSleep(job, job.intervalMs);
        continue;
      }
      const trains = (searched.data && searched.data.trains) || [];
      const wantSpecial = String(job.options.seatOption).startsWith("special");
      const candidate = trains.find((t) =>
        wantSpecial ? t.has_special_seat || t.has_general_seat : t.has_general_seat || t.has_special_seat
      );
      if (!candidate) {
        job.lastMessage = `빈 좌석 대기 중… (조회된 열차 ${trains.length}편)`;
        await interruptibleSleep(job, job.intervalMs);
        continue;
      }
      targetTrainId = candidate.train_id;
      job.lastMessage = `빈 좌석 발견: ${candidate.dep_time}~${candidate.arr_time} 예약 시도…`;
    }

    const res = await attemptReserve(job, targetTrainId);
    if (job.status !== "running") break;

    if (res.ok) {
      job.reservation = (res.data && res.data.reservation) || res.data || null;
      return finish(job, "reserved", "예약에 성공했습니다. 코레일 앱에서 결제해 주세요.");
    }

    const kind = classifyError(res.error);
    if (kind === "auth") return finish(job, "failed", "로그인 실패 — 아이디/비밀번호를 확인하세요.");
    if (kind === "config") return finish(job, "failed", "서버 설정 오류(코레일 계정 정보 누락).");
    if (kind === "gone" && job.mode === "train") {
      return finish(job, "failed", "선택한 열차가 더 이상 조회되지 않습니다(운행 종료/시간표 변경). 다시 조회해 주세요.");
    }

    job.lastMessage = "좌석이 없어 재시도 중…";
    await interruptibleSleep(job, job.intervalMs);
  }
}

/**
 * Start a background macro job.
 * @param {object} params
 * @param {object} params.creds  { id, password }
 * @param {object} params.trip   dep, arr, date, time, trainType, adults, ...
 * @param {object} params.options seatOption, tryWaiting, intervalMs, deadlineMs, maxAttempts
 * @param {string} [params.trainId] target train (omit for "auto" earliest mode)
 * @returns {object} public job snapshot
 */
function startJob(params) {
  const id = crypto.randomBytes(9).toString("base64url");
  const now = Date.now();
  const job = {
    id,
    status: "running",
    mode: params.trainId ? "train" : "auto",
    creds: params.creds,
    trip: params.trip,
    trainId: params.trainId || null,
    options: {
      seatOption: params.options.seatOption || "general-first",
      tryWaiting: !!params.options.tryWaiting,
      deadlineMs: params.options.deadlineMs || null,
      maxAttempts: params.options.maxAttempts || null,
    },
    intervalMs: params.options.intervalMs || 15000,
    attempts: 0,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    lastAttemptAt: null,
    nextAttemptAt: null,
    lastMessage: "매크로를 시작했습니다.",
    reservation: null,
  };
  jobs.set(id, job);

  // Kick off the loop in the background; surface unexpected crashes as failures.
  runLoop(job).catch((err) => {
    finish(job, "failed", `내부 오류: ${err && err.message ? err.message : err}`);
  });

  return publicJob(job);
}

function getJob(id) {
  return publicJob(jobs.get(id));
}

function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === "running") {
    finish(job, "stopped", "사용자가 매크로를 중지했습니다.");
  }
  return publicJob(job);
}

function listJobs() {
  return Array.from(jobs.values()).map(publicJob);
}

module.exports = { startJob, getJob, stopJob, listJobs };
