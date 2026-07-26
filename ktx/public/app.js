"use strict";

// ---- helpers -------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const API = "/api/ktx";
const FORM_KEY = "ktx.form.v1";
const JOB_KEY = "ktx.job.v1";

let pollTimer = null;
let audioCtx = null;

function ymd(dateInput) {
  // <input type=date> gives "YYYY-MM-DD"
  return (dateInput || "").replace(/-/g, "");
}
function hms(timeInput) {
  // <input type=time> gives "HH:MM"
  const t = (timeInput || "").replace(/:/g, "");
  return t.length === 4 ? t + "00" : t;
}

function collectCreds() {
  return { id: $("id").value.trim(), password: $("password").value };
}

function collectTrip() {
  return {
    dep: $("dep").value.trim(),
    arr: $("arr").value.trim(),
    date: ymd($("date").value),
    time: hms($("time").value),
    trainType: $("trainType").value,
    seatOption: $("seatOption").value,
    adults: parseInt($("adults").value, 10) || 0,
    children: parseInt($("children").value, 10) || 0,
    seniors: parseInt($("seniors").value, 10) || 0,
    tryWaiting: $("tryWaiting").checked,
  };
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

// ---- persistence (never store the password) ------------------------------
function saveForm() {
  const f = {
    id: $("id").value,
    dep: $("dep").value,
    arr: $("arr").value,
    date: $("date").value,
    time: $("time").value,
    trainType: $("trainType").value,
    seatOption: $("seatOption").value,
    adults: $("adults").value,
    children: $("children").value,
    seniors: $("seniors").value,
    tryWaiting: $("tryWaiting").checked,
    intervalSec: $("intervalSec").value,
    maxMinutes: $("maxMinutes").value,
  };
  try { localStorage.setItem(FORM_KEY, JSON.stringify(f)); } catch (e) {}
}
function restoreForm() {
  let f;
  try { f = JSON.parse(localStorage.getItem(FORM_KEY) || "null"); } catch (e) {}
  if (!f) {
    // sensible default date = tomorrow
    const d = new Date(Date.now() + 86400000);
    $("date").value = d.toISOString().slice(0, 10);
    return;
  }
  for (const k of ["id", "dep", "arr", "date", "time", "trainType", "seatOption",
    "adults", "children", "seniors", "intervalSec", "maxMinutes"]) {
    if (f[k] != null && $(k)) $(k).value = f[k];
  }
  if ($("tryWaiting")) $("tryWaiting").checked = !!f.tryWaiting;
  if (!$("date").value) {
    const d = new Date(Date.now() + 86400000);
    $("date").value = d.toISOString().slice(0, 10);
  }
}

// ---- search --------------------------------------------------------------
async function doSearch() {
  const btn = $("search-btn");
  const status = $("search-status");
  const creds = collectCreds();
  if (!creds.id || !creds.password) {
    status.className = "status-line err";
    status.textContent = "먼저 코레일 아이디/비밀번호를 입력하세요.";
    return;
  }
  saveForm();
  btn.disabled = true;
  status.className = "status-line";
  status.innerHTML = '<span class="spinner"></span>조회 중…';
  $("results").innerHTML = "";
  try {
    const body = Object.assign({}, creds, collectTrip(), { limit: 8 });
    const data = await postJSON(`${API}/search`, body);
    renderTrains(data.trains || []);
    status.textContent = `${(data.trains || []).length}개 열차 조회됨`;
  } catch (e) {
    status.className = "status-line err";
    status.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

function renderTrains(trains) {
  const box = $("results");
  box.innerHTML = "";
  if (!trains.length) {
    box.innerHTML = '<p class="hint">조건에 맞는 열차가 없습니다.</p>';
    return;
  }
  for (const t of trains) {
    const el = document.createElement("div");
    el.className = "train";
    const seat = t.has_general_seat || t.has_special_seat
      ? '<span class="seat-ok">예약 가능</span>'
      : (t.has_waiting_list ? '<span class="seat-no">예약 대기</span>' : '<span class="seat-no">매진</span>');
    el.innerHTML = `
      <div>
        <div class="times">${t.dep_time.slice(0,2)}:${t.dep_time.slice(2,4)} → ${t.arr_time.slice(0,2)}:${t.arr_time.slice(2,4)}</div>
        <div class="meta">${t.train_type} ${t.train_no}호 · ${t.dep_name}→${t.arr_name} · ${seat}</div>
      </div>`;
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = "이 열차 매크로";
    btn.onclick = () => startMacro(t.train_id);
    el.appendChild(btn);
    box.appendChild(el);
  }
}

// ---- macro ---------------------------------------------------------------
async function startMacro(trainId) {
  const creds = collectCreds();
  if (!creds.id || !creds.password) {
    alert("먼저 코레일 아이디/비밀번호를 입력하세요.");
    return;
  }
  await ensureNotifyPermission();
  saveForm();
  try {
    const body = Object.assign({}, creds, collectTrip(), {
      trainId: trainId || undefined,
      intervalSec: parseInt($("intervalSec").value, 10) || 15,
      maxMinutes: parseInt($("maxMinutes").value, 10) || 60,
    });
    const job = await postJSON(`${API}/macro`, body);
    localStorage.setItem(JOB_KEY, job.jobId);
    renderJob(job);
    startPolling(job.jobId);
  } catch (e) {
    alert("매크로 시작 실패: " + e.message);
  }
}

function startPolling(jobId) {
  stopPolling();
  pollTimer = setInterval(() => pollJob(jobId), 3000);
  pollJob(jobId);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function pollJob(jobId) {
  try {
    const res = await fetch(`${API}/macro/${jobId}`);
    if (res.status === 404) { stopPolling(); localStorage.removeItem(JOB_KEY); return; }
    const job = await res.json();
    renderJob(job);
    if (job.status !== "running") {
      stopPolling();
      if (job.status === "reserved") fireAlarm(job);
      localStorage.removeItem(JOB_KEY);
    }
  } catch (e) {
    // transient network issue — keep polling
  }
}

function renderJob(job) {
  const panel = $("job-panel");
  panel.classList.remove("hidden");
  const badge = $("job-badge");
  const labels = { running: "실행 중", reserved: "예약 성공", failed: "실패", stopped: "중지됨" };
  badge.textContent = labels[job.status] || job.status;
  badge.className = "badge " + job.status;
  $("stop-btn").style.display = job.status === "running" ? "" : "none";

  const started = job.startedAt ? new Date(job.startedAt) : null;
  const elapsed = started ? Math.round((Date.now() - started) / 1000) : 0;
  const modeLabel = job.mode === "auto" ? "가장 빠른 빈자리" : "지정 열차";
  $("job-detail").innerHTML = `
    <div>구간: <b>${job.trip.dep} → ${job.trip.arr}</b> · ${job.trip.date} ${job.trip.time.slice(0,2)}:${job.trip.time.slice(2,4)} 이후</div>
    <div>모드: <b>${modeLabel}</b> · 시도 <b>${job.attempts}</b>회 · 간격 ${job.intervalSec}초 · 경과 ${elapsed}s</div>`;

  const msg = $("job-message");
  if (job.status === "running") {
    msg.innerHTML = '<span class="spinner"></span>' + (job.lastMessage || "대기 중…");
  } else if (job.status === "reserved" && job.reservation) {
    const r = job.reservation;
    msg.innerHTML = `✅ 예약번호 <b>${r.reservation_id || "-"}</b> · ${r.price != null ? r.price + "원" : ""}<br>
      구입기한: ${r.buy_limit_date || ""} ${r.buy_limit_time || ""} — 코레일 앱에서 결제하세요.`;
  } else {
    msg.textContent = job.lastMessage || "";
  }
}

async function stopMacro() {
  const jobId = localStorage.getItem(JOB_KEY);
  if (!jobId) return;
  try {
    const job = await postJSON(`${API}/macro/${jobId}/stop`, {});
    renderJob(job);
    stopPolling();
    localStorage.removeItem(JOB_KEY);
  } catch (e) { /* ignore */ }
}

// ---- alarm (notification + vibrate + beep + banner) ----------------------
async function ensureNotifyPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch (e) {}
  }
}

function fireAlarm(job) {
  const r = job.reservation || {};
  const title = "🎉 KTX 예약 완료!";
  const bodyText = `${job.trip.dep}→${job.trip.arr} · 예약번호 ${r.reservation_id || "-"} · 코레일 앱에서 결제하세요.`;

  // 1) banner
  $("alarm-title").textContent = title;
  $("alarm-body").textContent = bodyText;
  $("alarm").classList.remove("hidden");

  // 2) system notification (works when tab is backgrounded)
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then((reg) =>
          reg.showNotification(title, { body: bodyText, tag: "ktx", vibrate: [300,120,300], icon: "icon.svg" })
        ).catch(() => new Notification(title, { body: bodyText }));
      } else {
        new Notification(title, { body: bodyText });
      }
    }
  } catch (e) {}

  // 3) vibrate
  try { navigator.vibrate && navigator.vibrate([300, 120, 300, 120, 300]); } catch (e) {}

  // 4) beep
  beep();
}

function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const notes = [880, 1175, 1568];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = audioCtx.currentTime + i * 0.22;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.22);
    });
  } catch (e) {}
}

// ---- boot ----------------------------------------------------------------
function reconnect() {
  const jobId = localStorage.getItem(JOB_KEY);
  if (jobId) startPolling(jobId);
}

window.addEventListener("DOMContentLoaded", () => {
  restoreForm();
  reconnect();
  $("search-btn").addEventListener("click", doSearch);
  $("auto-btn").addEventListener("click", () => startMacro(null));
  $("stop-btn").addEventListener("click", stopMacro);
  $("alarm-dismiss").addEventListener("click", () => $("alarm").classList.add("hidden"));
  ["change", "input"].forEach((ev) =>
    document.querySelectorAll("input,select").forEach((el) => el.addEventListener(ev, saveForm))
  );

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
});
