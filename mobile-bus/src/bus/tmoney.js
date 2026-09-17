// 시외버스 (Tmoney, https://intercitybus.tmoney.co.kr) on-device client.
//
// JS port of the k-skill intercity-bus-booking helper (intercity_bus_search.py).
// Session-proven flow: no login for timetable → fare/seat stage → temporary
// hold. The hold POST (readPcpySats.do) itself RENDERS the official 카드정보
// 입력 page and fails when replayed, so reserve() prepares the exact hold form
// and the app submits it as a WebView navigation (user then pays there).
//
// Same interface as the KOBUS client / KTX clients for the shared macro.

import { parseForm, fieldsToObject, attrs, stripTags, quotedArgs } from "./http-html.js";
import { TMONEY_TERMINALS, findTerminal } from "./terminals.js";
import { busError, pageDiag } from "./kobus.js";

const BASE = "https://intercitybus.tmoney.co.kr";
const ENTRY = `${BASE}/otck/trmlInfEnty.do`;
const TIMETABLE = `${BASE}/otck/readAlcnList.do`;
const SEAT_STAGE = `${BASE}/otck/readSatsFee.do`;
const HOLD = `${BASE}/otck/readPcpySats.do`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

const ROW_RE = /<tr>\s*([\s\S]*?)readSasFeeInf\(([\s\S]*?)\)[\s\S]*?<\/tr>/gi;
const TD_WRAP_RE = /<div class="td_wrap1">([\s\S]*?)<\/div>/gi;
const SEAT_RE = /<li([^>]*)>\s*<a[^>]*>[\s\S]*?<span>(\d+)<\/span>/gi;
const TRAIN_ID_PREFIX = "bus:v1:";

function b64url(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// helper parse_schedules(): rows with readSasFeeInf(...) buttons.
export function parseSchedules(html) {
  const out = [];
  for (const m of String(html).matchAll(ROW_RE)) {
    const rowHtml = m[1];
    const args = quotedArgs(m[2]);
    const cells = [...rowHtml.matchAll(TD_WRAP_RE)].map((c) => stripTags(c[1]));
    const depFromArgs = args.length > 8 ? `${args[8].slice(0, 2)}:${args[8].slice(2, 4)}` : null;
    const departure = cells.length > 0 ? cells[0] : depFromArgs;
    const companyCell = cells.length > 1 ? cells[1] : null;
    const company = args.length > 11 ? args[11] : null;
    let duration = null;
    if (companyCell && company && companyCell.startsWith(company)) duration = companyCell.slice(company.length).trim() || null;
    else if (companyCell) duration = companyCell;
    const busClass = args.length > 12 ? args[12] : (cells.length > 2 ? cells[2] : null);
    const remaining = args.length > 16 && /^\d+$/.test(args[16]) ? parseInt(args[16], 10) : null;
    const total = args.length > 17 && /^\d+$/.test(args[17]) ? parseInt(args[17], 10) : null;
    out.push({
      departure_time: departure, company, duration, bus_class: busClass,
      adult_fare: cells[3] ?? null, child_fare: cells[4] ?? null, student_fare: cells[5] ?? null,
      remaining_seats: remaining, total_seats: total, raw_args: args,
    });
  }
  return out;
}

// helper _seat_stage_fields()
export function seatStageFields(args, searchTime) {
  const a = args;
  if (a.length < 21) throw busError("readSasFeeInf 인자가 예상보다 적습니다(페이지 구조 변경?)", "other");
  return {
    atl_Depr_Dt_S1: a[2], atl_Depr_Time_S1: searchTime,
    rot_Id: a[0], rot_Sqno: a[1], alcn_Dt: a[2], alcn_Sqno: a[3],
    depr_Trml_Cd: a[4], arvl_Trml_Cd: a[5], depr_Trml_Nm: a[6], arvl_Trml_Nm: a[7],
    depr_Time: a[8], bus_Cacm_Cd: a[9], bus_Cls_Cd: a[10], bus_Cacm_Nm: a[11], bus_Cls_Nm: a[12],
    ig: a[13], im: a[14], ic: a[15], rmn_Scnt: a[16], sats_Num: a[17],
    atl_Depr_Dt: a[18], atl_Depr_Time: a[19], dc_Psb_Yn: a[20],
  };
}

export function availableSeats(seatStageHtml) {
  const seats = [];
  for (const m of String(seatStageHtml).matchAll(SEAT_RE)) {
    const cls = (attrs(m[1]).class || "").split(/\s+/);
    if (!cls.includes("disabled")) seats.push(m[2]);
  }
  return seats;
}

export function buildTrainId(t) {
  return TRAIN_ID_PREFIX + b64url(JSON.stringify({
    op: "tmoney", dep: t.dep_code, arr: t.arr_code, date: t.dep_date, dep_time: t.dep_time, company: t.train_no || "",
  }));
}

export class Tmoney {
  constructor(http) {
    this.http = http;
    this.sessionReady = false;
    this.terminals = TMONEY_TERMINALS.slice();
    this.logined = true;
  }

  async login() { return true; }

  _headers(referer, extra) {
    return Object.assign({ "User-Agent": UA }, referer ? { Referer: referer } : {}, extra || {});
  }

  async _ensureSession() {
    if (this.sessionReady) return;
    await this.http.request({ method: "GET", url: ENTRY, headers: this._headers() });
    this.sessionReady = true;
  }

  _term(v) {
    const t = findTerminal(this.terminals, v);
    if (t) return t;
    if (/^\d{7}$/.test(String(v).trim())) return { name: String(v).trim(), code: String(v).trim() };
    const known = this.terminals.map((x) => `${x.name}(${x.code})`).join(", ");
    throw busError(`시외버스 터미널 '${String(v).trim()}'을(를) 찾을 수 없습니다. 아는 터미널: ${known} — 티머니 시외버스 사이트의 7자리 터미널 코드를 직접 입력하세요.`, "other");
  }

  makePassengers({ adults = 1 } = {}) {
    return { list: [{ type_code: "IG", count: Math.max(1, adults) }], counts: { adults: Math.max(1, adults) } };
  }

  async searchTrain(dep, arr, date, time = "000000", opts = {}) {
    const d = this._term(dep);
    const a = this._term(arr);
    await this._ensureSession();
    const res = await this.http.request({
      method: "POST", url: TIMETABLE,
      data: {
        depr_Trml_Cd: d.code, arvl_Trml_Cd: a.code, depr_Trml_Nm: d.name, arvl_Trml_Nm: a.name,
        ig: "1", im: "0", ic: "0", iv: "0", depr_Dt: date, depr_Time: time || "000000",
        bef_Aft_Dvs: "D", req_Rec_Num: "10", // required hidden fields (else generic error page)
      },
      headers: this._headers(ENTRY, { "Content-Type": "application/x-www-form-urlencoded" }),
    });
    const html = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    const rows = parseSchedules(html);
    if (rows.length === 0) {
      throw busError(`시간표를 찾지 못했습니다 [${pageDiag(html)}]. 코드/날짜를 확인하세요(매진·미운행 가능).`, "noresults");
    }
    let trains = rows.map((r) => this._toTrain(r, d, a, date, time || "000000"));
    if (!opts.includeNoSeats) trains = trains.filter((t) => t.has_seat());
    return trains;
  }

  _toTrain(r, d, a, date, searchTime) {
    const depTime = r.raw_args[8] && r.raw_args[8].length >= 6 ? r.raw_args[8].slice(0, 6) : "";
    const t = {
      operator: "tmoney",
      dep_code: d.code, arr_code: a.code, dep_name: d.name, arr_name: a.name,
      dep_date: date, dep_time: depTime, arr_time: "",
      train_no: r.company || "시외버스", train_type_name: r.bus_class || "시외",
      remaining: r.remaining_seats, total: r.total_seats, fare: r.adult_fare,
      _raw_args: r.raw_args, _search_time: searchTime,
    };
    const has = () => (t.remaining == null ? true : t.remaining > 0);
    t.has_seat = has; t.has_general_seat = has;
    t.has_special_seat = () => false; t.has_general_waiting_list = () => false; t.has_waiting_list = () => false;
    return t;
  }

  buildTrainId(t) { return buildTrainId(t); }

  findTrainById(trains, id) {
    const hit = trains.find((t) => buildTrainId(t) === id);
    if (hit) return hit;
    let meta = {};
    try { meta = JSON.parse(atob(id.slice(TRAIN_ID_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/"))); } catch (_) {}
    const ph = { operator: "tmoney", dep_time: meta.dep_time || "", dep_date: meta.date || "", placeholder: true };
    ph.has_seat = () => false; ph.has_general_seat = () => false; ph.has_special_seat = () => false;
    ph.has_general_waiting_list = () => false; ph.has_waiting_list = () => false;
    return ph;
  }

  // Prepare the hold: fare/seat stage over HTTP, pick a seat, and return the
  // exact readPcpySats form. The app submits it in the WebView (pending:true).
  async reserve(train, opts = {}) {
    if (train.placeholder) throw busError("좌석 정보가 없는 편입니다.", "soldout");
    const stageFields = seatStageFields(train._raw_args, train._search_time);
    const res = await this.http.request({
      method: "POST", url: SEAT_STAGE, data: stageFields,
      headers: this._headers(TIMETABLE, { "Content-Type": "application/x-www-form-urlencoded" }),
    });
    const html = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    const seats = availableSeats(html);
    const selected = opts.seat || seats[0];
    if (!selected) throw busError("선택 가능한 좌석이 없습니다.", "soldout");
    if (!seats.includes(selected)) throw busError(`좌석 ${selected}은(는) 선택할 수 없습니다.`, "soldout");
    const fields = parseForm(html, "readPcpySats");
    if (fields.length === 0) throw busError("좌석 단계 응답에 readPcpySats 폼이 없습니다.", "other");
    const fmap = fieldsToObject(fields);
    // Mirror pcpySats() in readSatsInfo.js (adult-only hold) — appended.
    const holdFields = fields.concat([
      ["pcpy_Num", "1"], ["sats_No", selected], ["rtrp_Depr_Dt", ""],
      ["bus_Tck_Knd_Cd", fmap.ig_Knd_Cd || "IG00"], ["cty_Bus_Dc_Knd_Cd", "Z"], ["dcrt_Dvs_Cd", "0"],
    ]);
    return {
      operator: "tmoney",
      pending: true, // hold happens when the checkout form is submitted in the WebView
      reservation_id: null,
      seat: selected,
      price: train.fare ? parseInt(String(train.fare).replace(/[^\d]/g, ""), 10) || null : null,
      train_no: train.train_no, train_type: train.train_type_name,
      dep_name: train.dep_name, arr_name: train.arr_name,
      dep_date: train.dep_date, dep_time: train.dep_time, arr_time: "",
      buy_limit_date: null, buy_limit_time: null, seat_count: 1,
      checkout: { action: HOLD, fields: holdFields },
      cancel: null, // hold is created in the WebView; abandon via 뒤로가기 / it expires
    };
  }
}
