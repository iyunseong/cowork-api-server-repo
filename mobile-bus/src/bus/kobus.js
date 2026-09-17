// 고속버스 (KOBUS, https://www.kobus.co.kr) on-device client.
//
// JS port of the k-skill express-bus-booking helper (kobus_express_booking.py),
// whose HTTP flow was session-proven: no login is needed for timetable lookup,
// seat-stage entry, a TEMPORARY SEAT HOLD (setPcpy.ajax) and the checkout
// entry page. Payment itself is manual on the official KOBUS page.
//
// Exposes the same shape the shared macro engine (macro.js) drives:
//   login (no-op), searchTrain, reserve (= temporary hold), findTrainById,
//   buildTrainId, makePassengers, plus cancelHold / resolveTerminals.
// The site is server-rendered HTML, so we scrape with the helper's regexes.

import { parseForm, setField, fieldsToObject, attrs, stripTags, quotedArgs } from "./http-html.js";
import { KOBUS_TERMINALS, findTerminal } from "./terminals.js";

const BASE = "https://www.kobus.co.kr";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36";
const FN_SATS_RE = /fnSatsChc\(([\s\S]*?)\)/g;
const SEAT_RE = /<input\b([^>]*name=["']seatBoxDtl["'][^>]*)>/gi;

const TRAIN_ID_PREFIX = "bus:v1:";

function b64url(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Short human-readable description of an unexpected page so the on-screen
// error tells us WHAT came back (redirect / error page / captcha / login).
export function pageDiag(html) {
  const h = String(html || "");
  const title = (h.match(/<title>([\s\S]*?)<\/title>/i) || [, ""])[1].replace(/\s+/g, " ").trim().slice(0, 40);
  const flags = [];
  if (/mblIdx|mobile\/|\/mbl/i.test(h)) flags.push("모바일메인 리다이렉트");
  if (/errorCont|오류가 발생|시스템 오류/.test(h)) flags.push("오류페이지");
  if (/grecaptcha|recaptcha|captcha/i.test(h)) flags.push("캡차");
  if (/로그인|login/i.test(h) && !/fnSatsChc|readSasFeeInf/.test(h)) flags.push("로그인요구?");
  if (/접근이 제한|차단|Access Denied|403/i.test(h)) flags.push("접근차단");
  return `응답 ${h.length}자` + (title ? ` · 제목 '${title}'` : "") + (flags.length ? ` · ${flags.join(", ")}` : "");
}

export function busError(msg, kind = "other") {
  const e = new Error(msg);
  e.kind = kind;
  return e;
}

// Mirror the helper: only REPLACE keys that already exist in the form.
function overlayExisting(form, updates) {
  return form.map(([k, v]) => [k, Object.prototype.hasOwnProperty.call(updates, k) ? updates[k] : v]);
}

// seat_stage_fields(): search form + selected fnSatsChc(...) args.
export function seatStageFields(searchForm, args) {
  const a = args;
  return overlayExisting(searchForm, {
    deprTime: a[1],
    alcnDeprTime: a[2],
    alcnDeprTrmlNo: a[3],
    alcnArvlTrmlNo: a[4],
    indVBusClsCd: a[5],
    cacmCd: a[6],
    dcDvsCd: a[7],
    prvtBbizEmpAcmtRt: a[8],
    chldSftySatsYn: a[12],
    dsprSatsYn: a[13],
  });
}

// Parse the alcnSrch.do HTML into schedule records (helper search()).
export function parseSchedules(html) {
  const out = [];
  let idx = 0;
  for (const m of String(html).matchAll(FN_SATS_RE)) {
    idx += 1;
    const args = quotedArgs(m[1]);
    const ctx = stripTags(html.slice(Math.max(0, m.index - 900), m.index + 900));
    const depRaw = args[1] || "";
    const company = (ctx.match(/\((?:주|유)\)[^\s]+|[가-힣]+고속/) || [null])[0];
    const busClass = (ctx.match(/심야우등|우등|프리미엄|고속/) || [null])[0];
    // remaining_text: the helper's heuristic (first match in the ±900 window),
    // kept for parity with the Python oracle. remaining: the seat-count match
    // NEAREST to this fnSatsChc(), which is robust when rows sit close together.
    const remM = ctx.match(/잔여\s*\d+석|\d+\s*\/\s*\d+/);
    const remainingText = remM ? remM[0] : null;
    const remaining = nearestRemaining(html, m.index);
    out.push({ index: idx, dep_raw: depRaw, company, bus_class: busClass, remaining, remaining_text: remainingText, raw_args: args });
  }
  return out;
}

// Seat-count text closest (by character distance) to position `pos`.
function nearestRemaining(html, pos) {
  const lo = Math.max(0, pos - 900);
  const win = stripTagsKeepLen(String(html).slice(lo, pos + 900));
  const center = pos - lo;
  let best = null;
  for (const m of win.matchAll(/잔여\s*(\d+)석|(\d+)\s*\/\s*\d+/g)) {
    const dist = Math.abs(m.index - center);
    if (!best || dist < best.dist) best = { dist, val: parseInt(m[1] ?? m[2], 10) };
  }
  return best ? best.val : null;
}
// Blank out tags (keep string length so indexes stay comparable to `pos`).
function stripTagsKeepLen(s) {
  return s.replace(/<[^>]+>/g, (t) => " ".repeat(t.length));
}

function availableSeats(seatHtml) {
  const seats = [];
  for (const m of String(seatHtml).matchAll(SEAT_RE)) {
    const frag = m[1];
    const a = attrs(frag);
    if (!/disabled/i.test(frag) && a.value) seats.push(a.value);
  }
  return seats;
}

export function buildTrainId(t) {
  return TRAIN_ID_PREFIX + b64url(JSON.stringify({
    op: "kobus", dep: t.dep_code, arr: t.arr_code, date: t.dep_date, dep_time: t.dep_time, company: t.train_no || "",
  }));
}

export class Kobus {
  constructor(http) {
    this.http = http;
    this.sessionReady = false;
    this.terminals = KOBUS_TERMINALS.slice();
    this.logined = true;
  }

  async login() { return true; } // KOBUS hold flow needs no login

  _headers(referer, extra) {
    return Object.assign({ "User-Agent": UA }, referer ? { Referer: referer } : {}, extra || {});
  }

  async _ensureSession() {
    if (this.sessionReady) return;
    await this.http.request({ method: "GET", url: `${BASE}/main.do`, headers: this._headers() });
    this.sessionReady = true;
  }

  async _code(v) {
    const q = String(v || "").trim();
    if (/^\d{3}$/.test(q)) return findTerminal(this.terminals, q) || { name: q, code: q };
    let t = findTerminal(this.terminals, q);
    if (t) return t;
    // Unknown name: try to load the live route list once, then retry.
    if (!this._resolvedOnce) {
      this._resolvedOnce = true;
      try { await this.resolveTerminals(); } catch (_) {}
      t = findTerminal(this.terminals, q);
      if (t) return t;
    }
    const known = this.terminals.map((x) => `${x.name}(${x.code})`).slice(0, 12).join(", ");
    throw busError(`고속버스 터미널 '${q}'을(를) 찾을 수 없습니다. 아는 터미널: ${known}${this.terminals.length > 12 ? " …" : ""} — 코드 3자리를 직접 입력하세요.`, "other");
  }

  makePassengers({ adults = 1 } = {}) {
    return { list: [{ type_code: "1", count: Math.max(1, adults) }], counts: { adults: Math.max(1, adults) } };
  }

  // date: YYYYMMDD, time: HHMMSS (schedules departing at/after this time).
  async searchTrain(dep, arr, date, time = "000000", opts = {}) {
    const d = await this._code(dep);
    const a = await this._code(arr);
    await this._ensureSession();
    const res = await this.http.request({
      method: "POST",
      url: `${BASE}/mrs/alcnSrch.do`,
      data: {
        deprCd: d.code, arvlCd: a.code, pathDvs: "sngl", pathStep: "1", deprDtm: date,
        busClsCd: "0", rtrpChc: "1", timeLinkMin: "00", timeLinkMax: "23",
      },
      headers: this._headers(`${BASE}/main.do`, { "Content-Type": "application/x-www-form-urlencoded" }),
    });
    const html = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    const searchForm = parseForm(html, "alcnSrchFrm");
    const rows = parseSchedules(html);
    if (rows.length === 0) throw busError(`시간표를 찾지 못했습니다 [${pageDiag(html)}]. 매진·미운행이거나 사이트가 다른 페이지를 돌려줬습니다.`, "noresults");

    let trains = rows.map((r) => this._toTrain(r, d, a, date, searchForm));
    if (time) trains = trains.filter((t) => t.dep_time >= time);
    if (!opts.includeNoSeats) trains = trains.filter((t) => t.has_seat());
    return trains;
  }

  _toTrain(r, d, a, date, searchForm) {
    const depTime = r.dep_raw.length >= 6 ? r.dep_raw.slice(0, 6) : (r.dep_raw + "00").slice(0, 6);
    const t = {
      operator: "kobus",
      dep_code: d.code, arr_code: a.code,
      dep_name: d.name, arr_name: a.name,
      dep_date: date, dep_time: depTime, arr_time: "",
      train_no: r.company || "고속버스",
      train_type_name: r.bus_class || "고속",
      remaining: r.remaining,
      _raw_args: r.raw_args,
      _search_form: searchForm,
    };
    const has = () => (t.remaining == null ? true : t.remaining > 0);
    t.has_seat = has;
    t.has_general_seat = has;
    t.has_special_seat = () => false;
    t.has_general_waiting_list = () => false;
    t.has_waiting_list = () => false;
    return t;
  }

  buildTrainId(t) { return buildTrainId(t); }

  // Tolerant: a sold-out departure may render without fnSatsChc(), so a
  // missing target is treated as "still no seat" (keep polling), not "gone".
  findTrainById(trains, id) {
    const hit = trains.find((t) => buildTrainId(t) === id);
    if (hit) return hit;
    let meta = {};
    try { meta = JSON.parse(atob(id.slice(TRAIN_ID_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/"))); } catch (_) {}
    const ph = { operator: "kobus", dep_time: meta.dep_time || "", dep_date: meta.date || "", placeholder: true };
    ph.has_seat = () => false; ph.has_general_seat = () => false; ph.has_special_seat = () => false;
    ph.has_general_waiting_list = () => false; ph.has_waiting_list = () => false;
    return ph;
  }

  // reserve() == temporary seat hold (helper hold()). Returns a reservation
  // object carrying the checkout form for the official payment page.
  async reserve(train, opts = {}) {
    if (train.placeholder) throw busError("좌석 정보가 없는 편입니다.", "soldout");
    const stage = seatStageFields(train._search_form, train._raw_args);
    const seatRes = await this.http.request({
      method: "POST", url: `${BASE}/mrs/satschc.do`, data: fieldsToObject(stage),
      headers: this._headers(`${BASE}/mrs/alcnSrch.do`, { "Content-Type": "application/x-www-form-urlencoded" }),
    });
    const seatHtml = typeof seatRes.data === "string" ? seatRes.data : JSON.stringify(seatRes.data);
    let fields = parseForm(seatHtml, "satsChcFrm");
    if (fields.length === 0) throw busError("좌석 선택 단계 응답에 satsChcFrm 폼이 없습니다.", "other");
    const seats = availableSeats(seatHtml);
    const selected = opts.seat || seats[0];
    if (!selected) throw busError("선택 가능한 좌석이 없습니다.", "soldout");

    const fmap = fieldsToObject(fields);
    for (const [k, v] of Object.entries({
      selSeatNum: selected, selSeatCnt: "1", selAdltCnt: "1", selAdltDcCnt: "0",
      prmmDcDvsCd: fmap.prmmDcDvsCd || "0",
    })) fields = overlayExisting(fields, { [k]: v });

    const holdRes = await this.http.request({
      method: "POST", url: `${BASE}/mrs/setPcpy.ajax`, data: fieldsToObject(fields),
      headers: this._headers(`${BASE}/mrs/satschc.do`, { "Content-Type": "application/x-www-form-urlencoded" }),
    });
    let raw = holdRes.data;
    if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch (_) { raw = { MSG_CD: "?", MSG: raw.slice(0, 200) }; } }
    if (!raw || raw.MSG_CD !== "S0000") {
      throw busError(`선점 실패: ${(raw && (raw.MSG || raw.MSG_CD)) || "알 수 없는 응답"}`, "soldout");
    }

    // Checkout form = seat form + hold identifiers (doc: include nonMbrsYn=Y).
    let checkout = fields;
    for (const [k, v] of Object.entries({
      satsNoAll: String(raw.satsNoAll ?? ""), pcpyNoAll: String(raw.pcpyNoAll ?? ""),
      estmAmt: String(raw.ESTM_AMT ?? ""), dcAmt: String(raw.DC_AMT ?? ""), tissuAmt: String(raw.TISSU_AMT ?? ""),
      nonMbrsYn: "Y",
    })) checkout = setField(checkout, k, v);

    return {
      operator: "kobus",
      reservation_id: String(raw.pcpyNoAll ?? ""),
      seat: String(raw.satsNoAll ?? selected),
      price: parseInt(raw.TISSU_AMT || raw.ESTM_AMT || "0", 10) || null,
      train_no: train.train_no, train_type: train.train_type_name,
      dep_name: train.dep_name, arr_name: train.arr_name,
      dep_date: train.dep_date, dep_time: train.dep_time, arr_time: "",
      buy_limit_date: null, buy_limit_time: null, seat_count: 1,
      checkout: { action: `${BASE}/mrs/stplcfmpym.do?keep=/mrs/pay`, fields: checkout },
      cancel: { action: `${BASE}/mrs/cancPcpy.ajax`, fields: checkout },
    };
  }

  async cancelHold(reservation) {
    const res = await this.http.request({
      method: "POST", url: reservation.cancel.action, data: fieldsToObject(reservation.cancel.fields),
      headers: this._headers(`${BASE}/mrs/satschc.do`, { "Content-Type": "application/x-www-form-urlencoded" }),
    });
    let raw = res.data;
    if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch (_) { raw = {}; } }
    return !!raw && raw.MSG_CD === "S0000";
  }

  // Best-effort runtime terminal discovery from readRotLinInf.ajax. Record
  // field names are undocumented, so detect a 3-digit code + Korean name pair.
  async resolveTerminals() {
    await this._ensureSession();
    const res = await this.http.request({
      method: "POST", url: `${BASE}/mrs/readRotLinInf.ajax`, data: {},
      headers: this._headers(`${BASE}/main.do`, { "Content-Type": "application/x-www-form-urlencoded" }),
    });
    let data = res.data;
    if (typeof data === "string") { try { data = JSON.parse(data); } catch (_) { return []; } }
    const list = (data && (data.rotInfList || data.tfrInfList)) || [];
    const seen = new Map();
    for (const rec of list) {
      if (!rec || typeof rec !== "object") continue;
      const vals = Object.entries(rec);
      const codes = vals.filter(([, v]) => /^\d{3}$/.test(String(v))).map(([k, v]) => [k, String(v)]);
      const names = vals.filter(([, v]) => /[가-힣]/.test(String(v)) && String(v).length <= 20).map(([k, v]) => [k, String(v)]);
      // Pair by key stem (e.g. deprCd/deprNm, arvlCd/arvlNm) when possible.
      for (const [ck, code] of codes) {
        const stem = ck.replace(/(cd|code)$/i, "");
        const nm = names.find(([nk]) => nk.replace(/(nm|name)$/i, "") === stem) || null;
        if (nm && !seen.has(code)) seen.set(code, nm[1]);
      }
    }
    const found = [...seen.entries()].map(([code, name]) => ({ name, code }));
    if (found.length) {
      const merged = new Map(this.terminals.map((t) => [t.code, t]));
      for (const t of found) if (!merged.has(t.code)) merged.set(t.code, t);
      this.terminals = [...merged.values()];
    }
    return this.terminals;
  }
}
