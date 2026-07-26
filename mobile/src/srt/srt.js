// On-device SRT client — a JS port of the SRTrain Python library (SRT/srt.py,
// train.py, passenger.py, reservation.py, response_data.py) as used by the
// k-skill srt-booking skill. Runs entirely on the phone; talks to SRT's mobile
// API directly. No crypto; the only gate is NetFunnel (see netfunnel.js).
//
// Exposes the SAME shape as the Korail client so macro.js can drive either:
//   login, searchTrain, reserve, findTrainById, buildTrainId, makePassengers.
// Requests go through an injected `http` adapter (CapacitorHttp on device).

import { NetFunnel } from "./netfunnel.js";

const BASE = "https://app.srail.or.kr:443";
const EP = {
  main: `${BASE}/main/main.do`,
  login: `${BASE}/apb/selectListApb01080_n.do`,
  search: `${BASE}/ara/selectListAra10007_n.do`,
  reserve: `${BASE}/arc/selectListArc05013_n.do`,
  tickets: `${BASE}/atc/selectListAtc14016_n.do`,
};
const USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SRT-APP-iOS V.2.0.18";
const INVALID_NETFUNNEL_KEY = "NET000001";

// SRT-served stations only (수서 계통).
export const STATION_CODE = {
  "수서": "0551", "동탄": "0552", "평택지제": "0553", "곡성": "0049", "공주": "0514",
  "광주송정": "0036", "구례구": "0050", "김천(구미)": "0507", "나주": "0037", "남원": "0048",
  "대전": "0010", "동대구": "0015", "마산": "0059", "목포": "0041", "밀양": "0017",
  "부산": "0020", "서대구": "0506", "순천": "0051", "경주": "0508", "여수EXPO": "0053",
  "여천": "0139", "오송": "0297", "울산(통도사)": "0509", "익산": "0030", "전주": "0045",
  "정읍": "0033", "진영": "0056", "진주": "0063", "창원": "0057", "창원중앙": "0512",
  "천안아산": "0502", "포항": "0515",
};
const STATION_NAME = Object.fromEntries(Object.entries(STATION_CODE).map(([k, v]) => [v, k]));
const TRAIN_NAME = { "00": "KTX", "17": "SRT", "07": "KTX-산천", "10": "KTX-산천", "18": "ITX-마음" };
export const SRT_STATIONS = Object.keys(STATION_CODE);

const SEAT_TYPE = { "general-first": "GF", "general-only": "GO", "special-first": "SF", "special-only": "SO" };
const WINDOW_SEAT = { none: "000", true: "012", false: "013" };
const RESERVE_JOBID = { PERSONAL: "1101", STANDBY: "1102" };

const EMAIL_REGEX = /[^@]+@[^@]+\.[^@]+/;
const PHONE_REGEX = /^(\d{3})-(\d{3,4})-(\d{4})$/;

const TRAIN_ID_PREFIX = "srt:v1:";
const TRAIN_ID_FIELDS = [
  "train_number", "dep_date", "dep_time", "arr_date", "arr_time",
  "train_code", "dep_station_code", "arr_station_code",
  "dep_station_run_order", "arr_station_run_order",
];

export class SRTError extends Error {
  constructor(msg, kind = "other", code = null) {
    super(msg);
    this.name = "SRTError";
    this.kind = kind; // 'auth' | 'soldout' | 'noresults' | 'netfunnel' | 'other'
    this.code = code;
  }
}

// ----- response parsing ---------------------------------------------------
function parseResponse(json) {
  // SRTResponseData: strResult SUCC/FAIL lives in resultMap[0].
  if (!json || !json.resultMap) throw new SRTError("Unexpected SRT response", "other");
  const status = json.resultMap[0] || {};
  return {
    ok: status.strResult === "SUCC",
    message: status.msgTxt || "",
    code: status.msgCd || "",
    json,
  };
}

// ----- train --------------------------------------------------------------
export function parseTrain(d) {
  const t = {
    train_code: d.stlbTrnClsfCd,
    train_type_name: TRAIN_NAME[d.stlbTrnClsfCd] || "SRT",
    train_number: d.trnNo,
    train_no: d.trnNo,
    dep_date: d.dptDt,
    dep_time: d.dptTm,
    dep_station_code: d.dptRsStnCd,
    dep_name: STATION_NAME[d.dptRsStnCd] || d.dptRsStnCd,
    arr_date: d.arvDt,
    arr_time: d.arvTm,
    arr_station_code: d.arvRsStnCd,
    arr_name: STATION_NAME[d.arvRsStnCd] || d.arvRsStnCd,
    general_seat_state: d.gnrmRsvPsbStr || "",
    special_seat_state: d.sprmRsvPsbStr || "",
    reserve_wait_possible_code: d.rsvWaitPsbCd || "",
    arr_station_run_order: d.arvStnRunOrdr,
    arr_station_constitution_order: d.arvStnConsOrdr,
    dep_station_run_order: d.dptStnRunOrdr,
    dep_station_constitution_order: d.dptStnConsOrdr,
    _raw: d,
  };
  t.general_seat_available = () => t.general_seat_state.includes("예약가능");
  t.special_seat_available = () => t.special_seat_state.includes("예약가능");
  t.reserve_standby_available = () => t.reserve_wait_possible_code.includes("9");
  // Unified interface (matches Korail train):
  t.has_general_seat = t.general_seat_available;
  t.has_special_seat = t.special_seat_available;
  t.has_seat = () => t.general_seat_available() || t.special_seat_available();
  t.has_general_waiting_list = t.reserve_standby_available;
  t.has_waiting_list = t.reserve_standby_available;
  t.train_type = t.train_code;
  return t;
}

// ----- passengers ---------------------------------------------------------
// Returns { list: [{type_code, count, name}], counts }.
export function makePassengers({ adults = 1, children = 0, seniors = 0 } = {}) {
  const list = [];
  if (adults > 0) list.push({ type_code: "1", count: adults, name: "어른/청소년" });
  if (children > 0) list.push({ type_code: "5", count: children, name: "어린이" });
  if (seniors > 0) list.push({ type_code: "4", count: seniors, name: "경로" });
  if (list.length === 0) list.push({ type_code: "1", count: 1, name: "어른/청소년" });
  return { list, counts: { adults, children, seniors } };
}
function passengerDict(pax, isSpecial, windowSeat) {
  const total = pax.list.reduce((a, p) => a + p.count, 0);
  const data = { totPrnb: String(total), psgGridcnt: String(pax.list.length) };
  pax.list.forEach((p, i) => {
    const n = i + 1;
    data["psgTpCd" + n] = p.type_code;
    data["psgInfoPerPrnb" + n] = String(p.count);
    data["locSeatAttCd" + n] = WINDOW_SEAT[windowSeat == null ? "none" : windowSeat];
    data["rqSeatAttCd" + n] = "015";
    data["dirSeatAttCd" + n] = "009";
    data["smkSeatAttCd" + n] = "000";
    data["etcSeatAttCd" + n] = "000";
    data["psrmClCd" + n] = isSpecial ? "2" : "1";
  });
  return data;
}

// ----- train_id -----------------------------------------------------------
function b64urlNoPad(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function buildTrainId(train) {
  const obj = {};
  for (const f of TRAIN_ID_FIELDS) obj[f] = train[f];
  return TRAIN_ID_PREFIX + b64urlNoPad(new TextEncoder().encode(JSON.stringify(obj)));
}
export function findTrainById(trains, trainId) {
  return trains.find((t) => buildTrainId(t) === trainId) || null;
}

function normalizeReservation(train, pay) {
  return {
    reservation_id: train.pnrNo,
    train_no: pay.trnNo,
    train_type: TRAIN_NAME[pay.stlbTrnClsfCd] || "SRT",
    dep_name: STATION_NAME[pay.dptRsStnCd] || pay.dptRsStnCd,
    dep_date: pay.dptDt,
    dep_time: pay.dptTm,
    arr_name: STATION_NAME[pay.arvRsStnCd] || pay.arvRsStnCd,
    arr_date: pay.dptDt,
    arr_time: pay.arvTm,
    seat_count: parseInt(train.tkSpecNum || "0", 10),
    price: parseInt(train.rcvdAmt || "0", 10),
    buy_limit_date: pay.iseLmtDt,
    buy_limit_time: pay.iseLmtTm,
  };
}

export class SRT {
  constructor(http, { sleep } = {}) {
    this.http = http;
    this.netfunnel = new NetFunnel(http, { sleep });
    this.logined = false;
    this.membershipNumber = null;
  }

  _headers(extra) {
    return Object.assign({ "User-Agent": USER_AGENT, Accept: "application/json" }, extra || {});
  }

  async login(srtId, srtPw) {
    let loginType;
    let id = srtId;
    if (EMAIL_REGEX.test(srtId)) loginType = "2";
    else if (PHONE_REGEX.test(srtId)) { loginType = "3"; id = srtId.replace(/-/g, ""); }
    else loginType = "1";

    const data = {
      auto: "Y", check: "Y", page: "menu", deviceKey: "-", customerYn: "",
      login_referer: EP.main, srchDvCd: loginType, srchDvNm: id, hmpgPwdCphd: srtPw,
    };
    const res = await this.http.request({
      method: "POST", url: EP.login, data, headers: this._headers({ "Content-Type": "application/x-www-form-urlencoded" }),
    });
    const body = res.data || {};
    const userMap = body.userMap;
    if (userMap && userMap.MB_CRD_NO) {
      this.logined = true;
      this.membershipNumber = userMap.MB_CRD_NO;
      return true;
    }
    this.logined = false;
    const msg = body.MSG || "로그인 실패 — 아이디/비밀번호를 확인하세요.";
    throw new SRTError(msg, "auth");
  }

  async searchTrain(dep, arr, date, time, opts = {}) {
    const includeNoSeats = !!opts.includeNoSeats;
    const depCode = STATION_CODE[dep];
    const arrCode = STATION_CODE[arr];
    if (!depCode) throw new SRTError(`SRT 미취급 출발역: ${dep}`, "other");
    if (!arrCode) throw new SRTError(`SRT 미취급 도착역: ${arr}`, "other");

    const trains = await this._searchOnce(dep, arr, date, time, depCode, arrCode, true);
    let result = trains.filter((t) => t.train_type_name === "SRT");
    if (!includeNoSeats) result = result.filter((t) => t.has_seat());
    return result;
  }

  async _searchOnce(dep, arr, date, time, depCode, arrCode, useCache) {
    const netfunnelKey = await this.netfunnel.generateKey(useCache);
    const data = {
      chtnDvCd: "1", arriveTime: "N", seatAttCd: "015", psgNum: "1", trnGpCd: "109",
      stlbTrnClsfCd: "05", dptDt: date, dptTm: time, arvRsStnCd: arrCode, dptRsStnCd: depCode,
      netfunnelKey,
    };
    let collected = [];
    let curTime = time;
    for (let page = 0; page < 10; page++) {
      data.dptTm = curTime;
      const res = await this.http.request({
        method: "POST", url: EP.search, data,
        headers: this._headers({ "Content-Type": "application/x-www-form-urlencoded" }),
      });
      const parsed = parseResponse(res.data);
      if (!parsed.ok) {
        if (parsed.code === INVALID_NETFUNNEL_KEY && useCache) {
          return this._searchOnce(dep, arr, date, time, depCode, arrCode, false);
        }
        break; // FAIL on a page usually means "no more trains"
      }
      const raw = (((parsed.json.outDataSets || {}).dsOutput1) || []);
      if (!raw.length) break;
      const batch = raw.map(parseTrain);
      collected = collected.concat(batch);
      const last = batch[batch.length - 1];
      // advance to last dep_time + 1s
      curTime = addOneSecond(last.dep_time);
      if (batch.length < 1) break;
    }
    // de-dup by train_id (pages can overlap)
    const seen = new Set();
    const unique = [];
    for (const t of collected) {
      const id = buildTrainId(t);
      if (!seen.has(id)) { seen.add(id); unique.push(t); }
    }
    return unique;
  }

  async reserve(train, { passengers, seatOption = "general-first", tryWaiting = false } = {}) {
    const pax = passengers || makePassengers();
    const opt = SEAT_TYPE[seatOption] || "GF";
    let isSpecial = false;
    if (opt === "GO") isSpecial = false;
    else if (opt === "SO") isSpecial = true;
    else if (opt === "GF") isSpecial = !train.general_seat_available();
    else if (opt === "SF") isSpecial = train.special_seat_available();

    const standby = !train.has_seat() && tryWaiting && train.reserve_standby_available();
    const jobId = standby ? RESERVE_JOBID.STANDBY : RESERVE_JOBID.PERSONAL;

    const netfunnelKey = await this.netfunnel.generateKey(true);
    const data = {
      jobId, jrnyCnt: "1", jrnyTpCd: "11", jrnySqno1: "001", stndFlg: "N",
      trnGpCd1: "300", trnGpCd: "109", grpDv: "0", rtnDv: "0",
      stlbTrnClsfCd1: train.train_code,
      dptRsStnCd1: train.dep_station_code, dptRsStnCdNm1: train.dep_name,
      arvRsStnCd1: train.arr_station_code, arvRsStnCdNm1: train.arr_name,
      dptDt1: train.dep_date, dptTm1: train.dep_time, arvTm1: train.arr_time,
      trnNo1: String(parseInt(train.train_number, 10)).padStart(5, "0"),
      runDt1: train.dep_date,
      dptStnConsOrdr1: train.dep_station_constitution_order,
      arvStnConsOrdr1: train.arr_station_constitution_order,
      dptStnRunOrdr1: train.dep_station_run_order,
      arvStnRunOrdr1: train.arr_station_run_order,
      mblPhone: null,
      netfunnelKey,
    };
    if (jobId === RESERVE_JOBID.PERSONAL) data.reserveType = "11";
    Object.assign(data, passengerDict(pax, isSpecial, null));

    const res = await this.http.request({
      method: "POST", url: EP.reserve, data,
      headers: this._headers({ "Content-Type": "application/x-www-form-urlencoded" }),
    });
    const parsed = parseResponse(res.data);
    if (!parsed.ok) throw new SRTError(parsed.message || "예약 실패", "soldout", parsed.code);
    const reserved = (parsed.json.reservListMap || [])[0] || {};
    const pnr = reserved.pnrNo;
    const all = await this.getReservations();
    const match = all.find((r) => r.reservation_id === pnr);
    if (match) return match;
    // Fall back to a minimal reservation if reload didn't surface it yet.
    return { reservation_id: pnr, train_no: train.train_number, train_type: "SRT",
      dep_name: train.dep_name, arr_name: train.arr_name, dep_date: train.dep_date,
      dep_time: train.dep_time, arr_time: train.arr_time, price: null,
      buy_limit_date: null, buy_limit_time: null, seat_count: null };
  }

  async getReservations() {
    const res = await this.http.request({
      method: "POST", url: EP.tickets, data: { pageNo: "0" },
      headers: this._headers({ "Content-Type": "application/x-www-form-urlencoded" }),
    });
    const parsed = parseResponse(res.data);
    if (!parsed.ok) throw new SRTError(parsed.message || "예약 조회 실패", "other", parsed.code);
    const trains = parsed.json.trainListMap || [];
    const pays = parsed.json.payListMap || [];
    const out = [];
    for (let i = 0; i < trains.length; i++) {
      out.push(normalizeReservation(trains[i], pays[i] || {}));
    }
    return out;
  }

  findTrainById(trains, id) {
    return findTrainById(trains, id);
  }
  buildTrainId(train) {
    return buildTrainId(train);
  }
  makePassengers(opts) {
    return makePassengers(opts);
  }
}

function addOneSecond(hhmmss) {
  let h = parseInt(hhmmss.slice(0, 2), 10);
  let m = parseInt(hhmmss.slice(2, 4), 10);
  let s = parseInt(hhmmss.slice(4, 6), 10) + 1;
  if (s >= 60) { s -= 60; m += 1; }
  if (m >= 60) { m -= 60; h += 1; }
  if (h >= 24) h = 23; // clamp; SRT won't roll to next day here
  const p = (n) => String(n).padStart(2, "0");
  return p(h) + p(m) + p(s);
}
