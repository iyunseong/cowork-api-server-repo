// Android glue: wires the UI to the on-device Korail client + macro loop, using
// Capacitor native plugins (HTTP, Preferences, LocalNotifications, and a local
// ForegroundService plugin so the macro survives backgrounding).
//
// Pure logic (korail.js, macro.js) is unit-tested in Node; this file is the
// thin, device-only integration layer.

import { Korail, buildTrainId, buildPassengers } from "./korail/korail.js";
import { runMacro } from "./macro.js";

const Cap = window.Capacitor || {};
const P = Cap.Plugins || {};
const CapacitorHttp = P.CapacitorHttp;
const Preferences = P.Preferences;
const LocalNotifications = P.LocalNotifications;
const ForegroundService = P.ForegroundService; // local plugin; optional

const CREDS_KEY = "ktx.creds";
const FORM_KEY = "ktx.form";

const $ = (id) => document.getElementById(id);

// ---- native HTTP adapter (matches korail.js's http interface) ------------
function strMap(obj) {
  if (!obj) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v == null ? "" : String(v);
  return out;
}
const http = {
  async request({ method, url, params, data, headers }) {
    const h = Object.assign({}, headers);
    let body = data;
    if (data) {
      h["Content-Type"] = h["Content-Type"] || "application/x-www-form-urlencoded";
      body = strMap(data);
    }
    const res = await CapacitorHttp.request({
      method,
      url,
      params: strMap(params),
      data: body,
      headers: h,
    });
    let parsed = res.data;
    if (typeof parsed === "string") {
      try { parsed = JSON.parse(parsed); } catch (_) { /* leave as string */ }
    }
    return { status: res.status, data: parsed };
  },
};

// ---- persistence ---------------------------------------------------------
async function prefGet(key) {
  if (!Preferences) return null;
  const { value } = await Preferences.get({ key });
  return value ? JSON.parse(value) : null;
}
async function prefSet(key, val) {
  if (!Preferences) return;
  await Preferences.set({ key, value: JSON.stringify(val) });
}
async function prefRemove(key) {
  if (!Preferences) return;
  await Preferences.remove({ key });
}

// ---- form <-> state ------------------------------------------------------
function collectTrip() {
  return {
    dep: $("dep").value.trim(),
    arr: $("arr").value.trim(),
    date: $("date").value.replace(/-/g, ""),
    time: (($("time").value || "").replace(/:/g, "") + "0000").slice(0, 6),
    trainType: $("trainType").value,
    seatOption: $("seatOption").value,
    passengers: buildPassengers({
      adults: parseInt($("adults").value, 10) || 0,
      children: parseInt($("children").value, 10) || 0,
      seniors: parseInt($("seniors").value, 10) || 0,
    }),
    tryWaiting: $("tryWaiting").checked,
  };
}
function trainTypeCode(key) {
  return { ktx: "100", "itx-saemaeul": "101", mugunghwa: "102", nuriro: "102", "tonggeun": "103", "itx-cheongchun": "104", airport: "105", all: "109" }[key] || "100";
}

async function saveForm() {
  await prefSet(FORM_KEY, {
    dep: $("dep").value, arr: $("arr").value, date: $("date").value, time: $("time").value,
    trainType: $("trainType").value, seatOption: $("seatOption").value,
    adults: $("adults").value, children: $("children").value, seniors: $("seniors").value,
    tryWaiting: $("tryWaiting").checked, intervalSec: $("intervalSec").value, maxMinutes: $("maxMinutes").value,
    remember: $("remember").checked,
  });
  if ($("remember").checked) {
    await prefSet(CREDS_KEY, { id: $("id").value, password: $("password").value });
  } else {
    await prefRemove(CREDS_KEY);
  }
}
async function restore() {
  const f = await prefGet(FORM_KEY);
  if (f) {
    for (const k of ["dep", "arr", "date", "time", "trainType", "seatOption", "adults", "children", "seniors", "intervalSec", "maxMinutes"]) {
      if (f[k] != null && $(k)) $(k).value = f[k];
    }
    $("tryWaiting").checked = !!f.tryWaiting;
    $("remember").checked = !!f.remember;
  }
  if (!$("date").value) {
    $("date").value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  }
  const creds = await prefGet(CREDS_KEY);
  if (creds) { $("id").value = creds.id || ""; $("password").value = creds.password || ""; }
}

// ---- login helper --------------------------------------------------------
async function makeClient() {
  const id = $("id").value.trim();
  const pw = $("password").value;
  if (!id || !pw) throw new Error("코레일 아이디와 비밀번호를 입력하세요.");
  const k = new Korail(http);
  const ok = await k.login(id, pw);
  if (!ok) throw new Error("로그인 실패 — 아이디/비밀번호를 확인하세요.");
  return k;
}

// ---- search --------------------------------------------------------------
async function doSearch() {
  const status = $("search-status");
  $("search-btn").disabled = true;
  status.className = "status-line";
  status.innerHTML = '<span class="spinner"></span>로그인/조회 중…';
  $("results").innerHTML = "";
  try {
    await saveForm();
    const trip = collectTrip();
    const k = await makeClient();
    const trains = await k.searchTrain(trip.dep, trip.arr, trip.date, trip.time, {
      trainType: trainTypeCode(trip.trainType), passengers: trip.passengers, includeWaitingList: trip.tryWaiting,
    });
    renderTrains(trains);
    status.textContent = `${trains.length}개 열차 조회됨`;
  } catch (e) {
    status.className = "status-line err";
    status.textContent = e.message || String(e);
  } finally {
    $("search-btn").disabled = false;
  }
}

function fmtTime(t) { return `${t.slice(0, 2)}:${t.slice(2, 4)}`; }

function renderTrains(trains) {
  const box = $("results");
  box.innerHTML = "";
  if (!trains.length) { box.innerHTML = '<p class="hint">조건에 맞는 열차가 없습니다.</p>'; return; }
  for (const t of trains) {
    const el = document.createElement("div");
    el.className = "train";
    const seat = t.has_seat() ? '<span class="seat-ok">예약 가능</span>' : (t.has_waiting_list() ? '<span class="seat-no">예약 대기</span>' : '<span class="seat-no">매진</span>');
    el.innerHTML = `<div><div class="times">${fmtTime(t.dep_time)} → ${fmtTime(t.arr_time)}</div>
      <div class="meta">${t.train_type_name} ${t.train_no}호 · ${t.dep_name}→${t.arr_name} · ${seat}</div></div>`;
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = "이 열차 매크로";
    btn.onclick = () => startMacro(buildTrainId(t));
    el.appendChild(btn);
    box.appendChild(el);
  }
}

// ---- macro ---------------------------------------------------------------
let current = null; // { stop, promise }

async function ensureNotifPermission() {
  if (!LocalNotifications) return;
  try {
    const s = await LocalNotifications.checkPermissions();
    if (s.display !== "granted") await LocalNotifications.requestPermissions();
  } catch (_) {}
}

async function startForeground(text) {
  if (!ForegroundService) return;
  try {
    await ForegroundService.start({ title: "KTX 자동 예매", body: text || "빈자리 조회 중…", id: 1 });
  } catch (_) {}
}
async function updateForeground(text) {
  if (!ForegroundService || !ForegroundService.update) return;
  try { await ForegroundService.update({ title: "KTX 자동 예매", body: text, id: 1 }); } catch (_) {}
}
async function stopForeground() {
  if (!ForegroundService) return;
  try { await ForegroundService.stop(); } catch (_) {}
}

async function notifyReserved(reservation, trip) {
  const body = `${trip.dep}→${trip.arr} · 예약번호 ${reservation.reservation_id} · 코레일 앱에서 결제하세요.`;
  if (LocalNotifications) {
    try {
      await LocalNotifications.schedule({
        notifications: [{
          id: Math.floor(Date.now() % 100000),
          title: "🎉 KTX 예약 완료!",
          body,
        }],
      });
    } catch (_) {}
  }
  try { navigator.vibrate && navigator.vibrate([300, 120, 300]); } catch (_) {}
}

async function startMacro(trainId) {
  if (current) { alert("이미 매크로가 실행 중입니다. 먼저 중지하세요."); return; }
  let trip, korail;
  try {
    await saveForm();
    trip = collectTrip();
    await ensureNotifPermission();
    korail = await makeClient();
  } catch (e) {
    alert(e.message || String(e));
    return;
  }

  const intervalMs = Math.max(10, parseInt($("intervalSec").value, 10) || 15) * 1000;
  const maxMinutes = Math.max(1, parseInt($("maxMinutes").value, 10) || 60);

  let stopped = false;
  const shouldStop = () => stopped;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  showJob({ status: "running", attempts: 0, message: "매크로를 시작했습니다." }, trip);
  await startForeground("빈자리 조회 중…");

  const run = runMacro(
    {
      korail, dep: trip.dep, arr: trip.arr, date: trip.date, time: trip.time,
      trainType: trainTypeCode(trip.trainType), trainId, passengers: trip.passengers,
      seatOption: trip.seatOption, tryWaiting: trip.tryWaiting,
      intervalMs, deadlineMs: Date.now() + maxMinutes * 60000,
    },
    {
      sleep, shouldStop,
      onUpdate: (u) => {
        showJob(u, trip);
        if (u.status === "running" && u.message) updateForeground(u.message);
      },
    }
  ).then(async (result) => {
    current = null;
    await stopForeground();
    if (result.status === "reserved") await notifyReserved(result.reservation, trip);
    showJob(result, trip);
  }).catch(async (e) => {
    current = null;
    await stopForeground();
    showJob({ status: "failed", message: e.message || String(e), attempts: 0 }, trip);
  });

  current = { stop: () => { stopped = true; }, promise: run };
}

function stopMacro() {
  if (current) current.stop();
}

function showJob(job, trip) {
  const panel = $("job-panel");
  panel.classList.remove("hidden");
  const labels = { running: "실행 중", reserved: "예약 성공", failed: "실패", stopped: "중지됨" };
  const badge = $("job-badge");
  badge.textContent = labels[job.status] || job.status;
  badge.className = "badge " + job.status;
  $("stop-btn").style.display = job.status === "running" ? "" : "none";
  $("job-detail").innerHTML = `구간: <b>${trip.dep} → ${trip.arr}</b> · ${trip.date} ${fmtTime(trip.time)} 이후 · 시도 <b>${job.attempts || 0}</b>회`;
  const msg = $("job-message");
  if (job.status === "running") {
    msg.innerHTML = '<span class="spinner"></span>' + (job.message || "대기 중…");
  } else if (job.status === "reserved" && job.reservation) {
    const r = job.reservation;
    msg.innerHTML = `✅ 예약번호 <b>${r.reservation_id}</b> · ${r.price ? r.price + "원" : ""}<br>구입기한 ${r.buy_limit_date || ""} ${r.buy_limit_time ? fmtTime(r.buy_limit_time) : ""} — 코레일 앱에서 결제하세요.`;
  } else {
    msg.textContent = job.message || "";
  }
}

// ---- boot ----------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  if (!CapacitorHttp) {
    $("search-status").className = "status-line err";
    $("search-status").textContent = "네이티브 HTTP 플러그인을 찾을 수 없습니다. 앱을 다시 설치해 주세요.";
  }
  await restore();
  $("search-btn").addEventListener("click", doSearch);
  $("auto-btn").addEventListener("click", () => startMacro(null));
  $("stop-btn").addEventListener("click", stopMacro);
  document.querySelectorAll("input,select").forEach((el) => {
    el.addEventListener("change", saveForm);
  });
});
