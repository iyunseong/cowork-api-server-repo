// Android glue for the bus app: wires the UI to the KOBUS / Tmoney clients and
// the shared macro engine (macro.js, copied from the KTX app at build time).
// When a seat is caught the app holds it, notifies, and auto-navigates the
// WebView to the operator's official checkout page (payment stays manual).

import { createClient, OPERATORS } from "./client.js";
import { runMacro } from "./macro.js";

const Cap = window.Capacitor || {};
const P = Cap.Plugins || {};
const CapacitorHttp = P.CapacitorHttp;
const Preferences = P.Preferences;
const LocalNotifications = P.LocalNotifications;
const ForegroundService = P.ForegroundService;

const FORM_KEY = "bus.form";
const $ = (id) => document.getElementById(id);

// ---- native HTTP adapter --------------------------------------------------
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
    const res = await CapacitorHttp.request({ method, url, params: strMap(params), data: body, headers: h, responseType: "text" });
    let parsed = res.data;
    if (typeof parsed === "string") {
      const s = parsed.trim();
      if (s.startsWith("{") || s.startsWith("[")) { try { parsed = JSON.parse(s); } catch (_) { /* keep html/text */ } }
    }
    return { status: res.status, data: parsed, url: res.url || url };
  },
};

// ---- persistence ----------------------------------------------------------
async function prefGet(key) { if (!Preferences) return null; const { value } = await Preferences.get({ key }); return value ? JSON.parse(value) : null; }
async function prefSet(key, val) { if (!Preferences) return; await Preferences.set({ key, value: JSON.stringify(val) }); }

// ---- operator / terminals -------------------------------------------------
let terminalsByOp = { kobus: OPERATORS.kobus.terminals.slice(), tmoney: OPERATORS.tmoney.terminals.slice() };

function operator() { return $("operator").value === "tmoney" ? "tmoney" : "kobus"; }

function refreshTerminals() {
  const op = operator();
  const list = $("terminals");
  list.innerHTML = "";
  for (const t of terminalsByOp[op]) {
    const o = document.createElement("option");
    o.value = t.name; o.label = `${t.name} (${t.code})`;
    list.appendChild(o);
  }
  const digits = OPERATORS[op].codeDigits;
  $("dep").placeholder = op === "kobus" ? "서울경부 또는 코드 010" : "동서울 또는 코드 0511601";
  $("arr").placeholder = op === "kobus" ? "부산 또는 코드 700" : "속초 또는 코드 2482701";
  $("code-hint").textContent = `터미널 이름(목록) 또는 ${digits}자리 코드를 입력하세요.`;
}

async function loadTerminals() {
  const btn = $("load-terminals");
  const op = operator();
  btn.disabled = true; btn.textContent = "불러오는 중…";
  try {
    const c = createClient(op, http);
    const q = ($("dep").value || $("arr").value || "").trim();
    const list = await c.resolveTerminals(/^\d+$/.test(q) ? "" : q);
    terminalsByOp[op] = list;
    refreshTerminals();
    btn.textContent = `터미널 ${list.length}곳 불러옴`;
    if (c.lastResolveDiag && c.lastResolveDiag.length) {
      const d = $("term-diag");
      d.textContent = "조회 기록(개발자용): " + c.lastResolveDiag.join(" | ");
      d.classList.remove("hidden");
    }
  } catch (e) {
    btn.textContent = "터미널 목록 불러오기";
    alert("터미널 목록을 불러오지 못했습니다: " + (e.message || e));
  } finally { btn.disabled = false; }
}

// ---- form -----------------------------------------------------------------
function collectTrip() {
  return {
    dep: $("dep").value.trim(), arr: $("arr").value.trim(),
    date: $("date").value.replace(/-/g, ""),
    time: (($("time").value || "").replace(/:/g, "") + "0000").slice(0, 6),
    adults: parseInt($("adults").value, 10) || 1,
  };
}
async function saveForm() {
  await prefSet(FORM_KEY, {
    operator: $("operator").value, dep: $("dep").value, arr: $("arr").value, date: $("date").value, time: $("time").value,
    adults: $("adults").value, intervalSec: $("intervalSec").value, maxMinutes: $("maxMinutes").value,
    targetTime: $("targetTime").value, winFrom: $("winFrom").value, winTo: $("winTo").value,
  });
}
async function restore() {
  const f = await prefGet(FORM_KEY);
  if (f) for (const k of ["operator", "dep", "arr", "date", "time", "adults", "intervalSec", "maxMinutes", "targetTime", "winFrom", "winTo"]) if (f[k] != null && $(k)) $(k).value = f[k];
  refreshTerminals();
  if (!$("date").value) $("date").value = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
}

// ---- search ---------------------------------------------------------------
const fmtTime = (t) => (t && t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : t || "");

async function doSearch() {
  const status = $("search-status");
  $("search-btn").disabled = true;
  status.className = "status-line";
  status.innerHTML = '<span class="spinner"></span>조회 중…';
  $("results").innerHTML = "";
  try {
    await saveForm();
    const trip = collectTrip();
    if (!trip.dep || !trip.arr) throw new Error("출발/도착 터미널을 입력하세요.");
    const client = createClient(operator(), http);
    const rows = await client.searchTrain(trip.dep, trip.arr, trip.date, trip.time, { includeNoSeats: true });
    for (const r of rows) r._id = client.buildTrainId(r);
    renderRows(rows);
    const open = rows.filter((r) => r.has_seat()).length;
    status.textContent = `${rows.length}편 · 잔여 있음 ${open}편 (매진 편은 자동선점 대기 가능)`;
  } catch (e) {
    status.className = "status-line err";
    status.textContent = e.message || String(e);
    if (e.debugHtml) offerDebugShare(e.debugHtml, `bus-${operator()}-response.html`);
  } finally { $("search-btn").disabled = false; }
}

// Developer diagnostics: let the user send the raw server page (share sheet →
// clipboard → on-screen text as fallbacks). Contains no login data.
let lastDebug = null;
function offerDebugShare(html, filename) {
  lastDebug = { html: String(html), filename };
  const box = $("debug-box");
  box.classList.remove("hidden");
  $("debug-text").value = "";
  $("debug-text").classList.add("hidden");
}
async function shareDebug() {
  if (!lastDebug) return;
  const { html, filename } = lastDebug;
  try {
    if (navigator.share) {
      let file = null;
      try { file = new File([html], filename, { type: "text/html" }); } catch (_) {}
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: filename }); return; }
      await navigator.share({ title: filename, text: html.slice(0, 60000) }); return;
    }
  } catch (e) { if (e && e.name === "AbortError") return; }
  try { await navigator.clipboard.writeText(html); alert("응답 내용을 클립보드에 복사했습니다. 채팅에 붙여넣어 주세요."); return; } catch (_) {}
  const ta = $("debug-text"); ta.value = html; ta.classList.remove("hidden"); ta.select();
}

function renderRows(rows) {
  const box = $("results");
  box.innerHTML = "";
  if (!rows.length) { box.innerHTML = '<p class="hint">조건에 맞는 편이 없습니다.</p>'; return; }
  for (const r of rows) {
    const el = document.createElement("div");
    el.className = "train";
    const has = r.has_seat();
    const seat = has ? `<span class="seat-ok">잔여 ${r.remaining ?? "?"}석</span>` : '<span class="seat-no">매진</span>';
    el.innerHTML = `<div><div class="times">${fmtTime(r.dep_time)} 출발</div>
      <div class="meta">${r.train_no} · ${r.train_type_name} · ${r.dep_name}→${r.arr_name} · ${seat}${r.fare ? " · " + r.fare : ""}</div></div>`;
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = has ? "이 차 선점" : "자동선점 대기";
    btn.onclick = () => startMacro(r._id);
    el.appendChild(btn);
    box.appendChild(el);
  }
}

// ---- macro ----------------------------------------------------------------
let current = null;
let runSeq = 0;
let lastReservation = null;

async function ensureNotifPermission() {
  if (!LocalNotifications) return;
  try { const s = await LocalNotifications.checkPermissions(); if (s.display !== "granted") await LocalNotifications.requestPermissions(); } catch (_) {}
}
async function fg(method, text) {
  if (!ForegroundService || !ForegroundService[method]) return;
  try { await ForegroundService[method]({ title: "버스 자동선점 실행 중", body: text || "빈자리 조회 중…", id: 1 }); } catch (_) {}
}
async function notify(title, body) {
  if (LocalNotifications) { try { await LocalNotifications.schedule({ notifications: [{ id: Math.floor(Date.now() % 100000), title, body }] }); } catch (_) {} }
  try { navigator.vibrate && navigator.vibrate([300, 120, 300]); } catch (_) {}
}

// Submit the operator's checkout form as a top-level WebView navigation.
// CapacitorHttp and the WebView share the Android cookie store, so the hold
// session travels with it (documented pattern from the k-skill helpers).
function openCheckout(checkout) {
  if (!checkout) return;
  const form = document.createElement("form");
  form.method = "post";
  form.action = checkout.action;
  form.style.display = "none";
  for (const [k, v] of checkout.fields) {
    const i = document.createElement("input");
    i.type = "hidden"; i.name = k; i.value = v == null ? "" : String(v);
    form.appendChild(i);
  }
  document.body.appendChild(form);
  form.submit();
}

// win = { from: "HHMMSS", to: "HHMMSS" } → auto mode limited to that departure window.
async function startMacro(trainId, win = null) {
  if (current) { alert("이미 실행 중입니다. 먼저 중지하세요."); return; }
  let trip, client;
  try {
    await saveForm();
    trip = collectTrip();
    if (!trip.dep || !trip.arr) throw new Error("출발/도착 터미널을 입력하세요.");
    await ensureNotifPermission();
    client = createClient(operator(), http);
  } catch (e) { alert(e.message || String(e)); return; }

  const intervalMs = Math.max(5, parseInt($("intervalSec").value, 10) || 10) * 1000;
  const maxMinutes = Math.max(1, parseInt($("maxMinutes").value, 10) || 60);
  const myRun = ++runSeq;
  let stopped = false;
  const shouldStop = () => stopped || myRun !== runSeq;
  const sleep = (ms) => new Promise((resolve) => { const s = Date.now(); (function tick() { if (shouldStop() || Date.now() - s >= ms) return resolve(); setTimeout(tick, 250); })(); });
  const handle = { stop: () => { stopped = true; } };
  current = handle;

  if (win) trip.label = `${fmtTime(win.from)}~${fmtTime(win.to)} 사이 아무 편`;
  else if (trainId) trip.label = "지정 편 대기";
  else trip.label = `${fmtTime(trip.time)} 이후 가장 빠른 편`;
  showJob({ status: "running", attempts: 0, message: "자동선점을 시작했습니다." }, trip);
  await fg("start", "빈자리 조회 중…");

  runMacro(
    { client, dep: trip.dep, arr: trip.arr, date: trip.date, time: trainId ? "000000" : win ? win.from : trip.time, trainId,
      timeMax: win ? win.to : null,
      passengers: client.makePassengers({ adults: trip.adults }), seatOption: "general-first", tryWaiting: false,
      intervalMs, deadlineMs: Date.now() + maxMinutes * 60000 },
    { sleep, shouldStop, onUpdate: (u) => { if (myRun !== runSeq) return; showJob(u, trip); if (u.status === "running" && u.message) fg("update", u.message); } }
  ).then(async (result) => {
    if (current === handle) current = null;
    await fg("stop");
    if (myRun !== runSeq) return;
    showJob(result, trip);
    if (result.status === "reserved") {
      lastReservation = result.reservation;
      const r = result.reservation;
      await notify("🎉 자리 확보! 바로 결제하세요", `${r.dep_name}→${r.arr_name} ${fmtTime(r.dep_time)} · 좌석 ${r.seat} · 선점은 몇 분 내 만료됩니다`);
      openCheckout(r.checkout); // auto-navigate to the official payment page
    }
  }).catch(async (e) => {
    if (current === handle) current = null;
    await fg("stop");
    if (myRun === runSeq) showJob({ status: "failed", message: e.message || String(e), attempts: 0 }, trip);
  });
}

function stopMacro() { if (current) { current.stop(); current = null; } }

// Target a departure by time — works even when the sold-out departure is not
// listed (no booking button). The macro keeps polling until a seat appears.
async function startTargetMacro() {
  const hhmm = ($("targetTime").value || "").replace(/:/g, "");
  if (hhmm.length !== 4) { alert("노릴 출발시각을 입력하세요 (예: 14:30)"); return; }
  try {
    const trip = collectTrip();
    if (!trip.dep || !trip.arr) throw new Error("출발/도착 터미널을 입력하세요.");
    const client = createClient(operator(), http);
    const id = await client.targetId(trip.dep, trip.arr, trip.date, hhmm + "00");
    await startMacro(id);
  } catch (e) { alert(e.message || String(e)); }
}

// "HH:MM ~ HH:MM 사이 아무 편": auto mode with a departure window. The macro
// grabs the earliest departure inside the window that has a seat.
async function startWindowMacro() {
  const from = ($("winFrom").value || "").replace(/:/g, "");
  const to = ($("winTo").value || "").replace(/:/g, "");
  if (from.length !== 4 || to.length !== 4) { alert("시작·끝 시각을 모두 입력하세요 (예: 13:00 ~ 16:00)"); return; }
  if (from > to) { alert("끝 시각이 시작 시각보다 빨라요."); return; }
  await startMacro(null, { from: from + "00", to: to + "59" });
}

function showJob(job, trip) {
  $("job-panel").classList.remove("hidden");
  const labels = { running: "실행 중", reserved: "선점 성공", failed: "실패", stopped: "중지됨" };
  const badge = $("job-badge");
  badge.textContent = labels[job.status] || job.status;
  badge.className = "badge " + job.status;
  $("stop-btn").style.display = job.status === "running" ? "" : "none";
  $("job-detail").innerHTML = `구간: <b>${trip.dep} → ${trip.arr}</b> · ${trip.date} · ${trip.label || fmtTime(trip.time) + " 이후"} · 시도 <b>${job.attempts || 0}</b>회`;
  const msg = $("job-message");
  if (job.status === "running") {
    msg.innerHTML = '<span class="spinner"></span>' + (job.message || "대기 중…");
  } else if (job.status === "reserved" && job.reservation) {
    const r = job.reservation;
    msg.innerHTML = `✅ ${r.dep_name}→${r.arr_name} ${fmtTime(r.dep_time)} · 좌석 <b>${r.seat}</b>${r.price ? " · " + r.price.toLocaleString() + "원" : ""}<br>` +
      (r.pending ? "결제 페이지에서 좌석이 선점됩니다. " : `선점번호 ${r.reservation_id}. `) + "<b>선점은 몇 분 내 만료</b>되니 바로 결제하세요.";
    const again = document.createElement("button");
    again.className = "primary"; again.style.marginTop = "8px"; again.textContent = "결제 페이지 열기";
    again.onclick = () => openCheckout(r.checkout);
    msg.appendChild(document.createElement("br")); msg.appendChild(again);
    if (r.cancel) {
      const cancel = document.createElement("button");
      cancel.className = "ghost small"; cancel.style.marginTop = "8px"; cancel.textContent = "선점 취소";
      cancel.onclick = async () => {
        if (!confirm("선점을 취소할까요?")) return;
        try { const ok = await createClient(operator(), http).cancelHold(r); alert(ok ? "선점을 취소했습니다." : "취소 응답이 성공이 아닙니다(이미 만료됐을 수 있음)."); }
        catch (e) { alert("취소 실패: " + (e.message || e)); }
      };
      msg.appendChild(cancel);
    }
  } else {
    msg.textContent = job.message || "";
  }
}

// ---- boot -----------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  if (!CapacitorHttp) {
    $("search-status").className = "status-line err";
    $("search-status").textContent = "네이티브 HTTP 플러그인을 찾을 수 없습니다. 앱을 다시 설치해 주세요.";
  }
  await restore();
  $("operator").addEventListener("change", () => { refreshTerminals(); saveForm(); });
  $("load-terminals").addEventListener("click", loadTerminals);
  $("search-btn").addEventListener("click", doSearch);
  $("auto-btn").addEventListener("click", () => startMacro(null));
  $("target-btn").addEventListener("click", startTargetMacro);
  $("window-btn").addEventListener("click", startWindowMacro);
  $("debug-share").addEventListener("click", shareDebug);
  $("stop-btn").addEventListener("click", stopMacro);
  document.querySelectorAll("input,select").forEach((el) => el.addEventListener("change", saveForm));
});
