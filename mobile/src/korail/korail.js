// On-device Korail client for the 코레일+ mobile API (app 7.0.8 protocol).
//
// Started as a JS port of the korail2-based helper in ktx/ktx_booking.py; after
// the 2026-09 코레일+ migration Korail changed the anti-bot token (DynaPath SDK
// v1.0.3), the app/version identity fields and the login handshake, so the
// request flow now follows what the official app sends (cross-checked against
// the open-source pykorail 0.2.0 [MIT] and korail-mobile-api 2.3.0 [Apache-2.0]
// clients, which were derived from the app). Runs entirely on the phone.
//
// The token/crypto pieces and the search/reservation forms are verified
// against korail-mobile-api in mobile/test/parity.test.js and client.test.js.
//
// An `http` adapter must be injected: http.request({ method, url, params, data,
// headers }) -> Promise<{ status, data }> where data is the parsed JSON body.
// In the app this is backed by CapacitorHttp (native requests share the WebView
// cookie store, so Korail's session cookies persist across calls).

import { DynaPath } from "./dynapath.js";
import { encryptPassword } from "./crypto.js";
import { resultCheck, NeedToLoginError, NoResultsError, SoldOutError, KorailError } from "./errors.js";
import { KorailQueue } from "./netfunnel.js";

const ORIGIN = "https://smart.letskorail.com";
const BASE = ORIGIN + "/classes/com.korail.mobile.";
export const URLS = {
  SERVICE: ORIGIN + "/file/CACHE/MobileService.cache",
  CODE: BASE + "common.code.do",
  LOGIN: BASE + "login.Login",
  SEARCH: BASE + "seatMovie.ScheduleView",
  RESERVE: BASE + "certification.TicketReservation",
  RESERVATIONS: BASE + "reservation.ReservationView",
  CANCEL: BASE + "reservationCancel.ReservationCancelChk",
};

// App identity (코레일+ 7.0.8). Do not change working values casually: the
// server gates on them (SUPDATE = "update the app").
const DEVICE = "AD";
const VERSION = "250601003";
const APP_VERSION = "7.0.8";
const API_KEY = "korail1234567890";
const COMMON_CODES = [
  "app.display.image", "app.menu.railpoint", "app.main.popup", "app.easyLogin.isShow", "app.korail.boss",
  "app.menu.buynow", "app.menu.lost112", "app.event.easyPay", "app.hndy.athn", "app.view.visibility",
  "app.menu.biz", "app.event.point", "app.var.data", "app.login.cphd", "app.illegal.report",
  "app.holiday.popup", "app.MaaS.test", "app.limousine.mainMsg",
];
const LOGIN_OK_CODES = new Set(["IRZ000001", "S200"]);
// DynaPath interceptor block codes (integer field in the reply body).
const DYNAPATH_BLOCK_CODES = new Set([-1203, -1406, -2000, -8005, -8201, -8202, -8203]);

// Paths that require the Dynapath token + Sid (from ktx_booking.py).
const DYNAPATH_PATHS = [
  "certification.TicketReservation",
  "nonMember.NonMemTicket",
  "research.TrainResearch",
  "research.ResidualSeatsResearch",
  "seatMovie.ScheduleView",
  "trn.prcFare",
  "login.Login",
];

export const TRAIN_TYPES = {
  ktx: "100",
  "itx-saemaeul": "101",
  mugunghwa: "102",
  nuriro: "102",
  tonggeun: "103",
  "itx-cheongchun": "104",
  airport: "105",
  all: "109",
};

export const RESERVE_OPTION = {
  GENERAL_FIRST: "GENERAL_FIRST",
  GENERAL_ONLY: "GENERAL_ONLY",
  SPECIAL_FIRST: "SPECIAL_FIRST",
  SPECIAL_ONLY: "SPECIAL_ONLY",
};

const USER_AGENT = "korailtalk"; // observed API User-Agent of the 코레일+ app
const EMAIL_REGEX = /[^@]+@[^@]+\.[^@]+/;
const PHONE_REGEX = /^(\d{3})-(\d{3,4})-(\d{4})$/;
const PHONE_DIGITS_REGEX = /^01\d{8,9}$/;

const TRAIN_ID_PREFIX = "ktx:v1:";
const TRAIN_ID_FIELDS = [
  "train_no", "dep_date", "dep_time", "arr_date", "arr_time",
  "run_date", "train_group", "dep_code", "arr_code",
];

// ----- response parsing (Schedule/Train/Reservation) ----------------------
function parseTrain(d) {
  const t = {
    train_type: d.h_trn_clsf_cd,
    train_type_name: d.h_trn_clsf_nm,
    train_group: d.h_trn_gp_cd,
    train_no: d.h_trn_no,
    dep_name: d.h_dpt_rs_stn_nm,
    dep_code: d.h_dpt_rs_stn_cd,
    dep_date: d.h_dpt_dt,
    dep_time: d.h_dpt_tm,
    arr_name: d.h_arv_rs_stn_nm,
    arr_code: d.h_arv_rs_stn_cd,
    arr_date: d.h_arv_dt,
    arr_time: d.h_arv_tm,
    run_date: d.h_run_dt,
    dep_cons_ordr: d.h_dpt_stn_cons_ordr,
    dep_run_ordr: d.h_dpt_stn_run_ordr,
    arr_cons_ordr: d.h_arv_stn_cons_ordr,
    arr_run_ordr: d.h_arv_stn_run_ordr,
    reserve_possible: d.h_rsv_psb_flg,
    reserve_possible_name: d.h_rsv_psb_nm,
    special_seat: d.h_spe_rsv_cd,
    general_seat: d.h_gen_rsv_cd,
    wait_reserve_flag: d.h_wait_rsv_flg ? parseInt(d.h_wait_rsv_flg, 10) : d.h_wait_rsv_flg,
    _raw: d,
  };
  t.has_special_seat = () => t.special_seat === "11";
  t.has_general_seat = () => t.general_seat === "11";
  t.has_seat = () => t.has_general_seat() || t.has_special_seat();
  t.has_general_waiting_list = () => t.wait_reserve_flag === 9;
  t.has_waiting_list = () => t.has_general_waiting_list();
  return t;
}

function parseReservation(d, top = {}) {
  return {
    reservation_id: d.h_pnr_no,
    train_no: d.h_trn_no,
    train_type: d.h_trn_clsf_nm,
    dep_name: d.h_dpt_rs_stn_nm,
    dep_date: d.h_run_dt,
    dep_time: d.h_dpt_tm,
    arr_name: d.h_arv_rs_stn_nm,
    arr_date: d.h_run_dt,
    arr_time: d.h_arv_tm,
    seat_count: parseInt(d.h_tot_seat_cnt || "0", 10),
    price: parseInt(d.h_rsv_amt || "0", 10),
    buy_limit_date: d.h_ntisu_lmt_dt,
    buy_limit_time: d.h_ntisu_lmt_tm,
    journey_no: d.h_jrny_sqno || d.txtJrnySqno || "001",
    journey_cnt: top.h_jrny_cnt || d.txtJrnyCnt || "1",
    rsv_chg_no: d.hidRsvChgNo || "000",
  };
}

// application/x-www-form-urlencoded with repeated keys (code=a&code=b).
export function encodeForm(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
    else if (v !== undefined && v !== null) p.append(k, String(v));
  }
  return p.toString();
}

function excerpt(data, status) {
  const raw = typeof data === "string" ? data : JSON.stringify(data);
  const text = String(raw || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return `코레일 봉투가 아닌 응답 (HTTP ${status}): ${text.slice(0, 240) || "(빈 응답)"}`;
}

// ----- train_id (stable selector), matching ktx_booking.py ----------------
function base64urlNoPad(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function buildTrainId(train) {
  const obj = {};
  for (const f of TRAIN_ID_FIELDS) obj[f] = train[f];
  const json = JSON.stringify(obj); // keys in TRAIN_ID_FIELDS order, no spaces
  return TRAIN_ID_PREFIX + base64urlNoPad(new TextEncoder().encode(json));
}
function trainIdFields(train) {
  const obj = {};
  for (const f of TRAIN_ID_FIELDS) obj[f] = train[f];
  return JSON.stringify(obj);
}
function findTrainById(trains, trainId) {
  const target = trainId.startsWith(TRAIN_ID_PREFIX) ? trainId : null;
  return trains.find((t) => buildTrainId(t) === target) || null;
}

// ----- passengers ---------------------------------------------------------
// Returns { list: [{typecode, discount_type, count}], counts: {...} }.
function buildPassengers({ adults = 1, children = 0, toddlers = 0, seniors = 0 } = {}) {
  const list = [];
  if (adults > 0) list.push({ typecode: "1", discount_type: "000", count: adults });
  if (children > 0) list.push({ typecode: "3", discount_type: "000", count: children });
  if (toddlers > 0) list.push({ typecode: "3", discount_type: "321", count: toddlers });
  if (seniors > 0) list.push({ typecode: "1", discount_type: "131", count: seniors });
  if (list.length === 0) list.push({ typecode: "1", discount_type: "000", count: 1 });
  return { list, counts: { adults, children, toddlers, seniors } };
}
function passengerGetDict(p, index) {
  const i = String(index);
  return {
    ["txtPsgTpCd" + i]: p.typecode,
    ["txtDiscKndCd" + i]: p.discount_type,
    ["txtCompaCnt" + i]: p.count,
    ["txtCardCode_" + i]: "",
    ["txtCardNo_" + i]: "",
    ["txtCardPw_" + i]: "",
  };
}

// 16 hex chars, like Android's android_id (what the SDK puts in `di`).
export function randomDeviceId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomNonce() {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // SDK alphabet
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export class Korail {
  // identity: { deviceId, appStartTs, osVersion, deviceModel, dyna } — pass the
  // SAME object for every client created during one app run so the DynaPath
  // history (`it`, `rt`) and the device id look like one phone running one app.
  // The device id must be unique per install: the fixed id that the korail2
  // lineage shipped is shared by every macro user and is now rejected by Korail
  // ("매크로 등 미허가 도구 사용 시 이용이 제한될 수 있습니다").
  constructor(http, { identity = null, appStartTs, queue = true } = {}) {
    this.http = http;
    this.device = DEVICE;
    this.version = VERSION;
    this.appVersion = APP_VERSION;
    const id = identity || {};
    this.deviceId = id.deviceId || randomDeviceId();
    if (!id.dyna) id.dyna = new DynaPath(id.appStartTs || appStartTs || Date.now(), { osVersion: id.osVersion, deviceModel: id.deviceModel });
    this.dyna = id.dyna;
    this.queue = queue ? new KorailQueue(http) : null;
    this.key = API_KEY;
    this.idx = null;
    this.logined = false;
    this.membershipNumber = null;
    this.custNo = null;
    this.name = null;
    this.lastLoginMessage = null;
    this.lastLoginRaw = null;
  }

  // Fields the app puts on (almost) every request.
  _common() {
    return { Device: this.device, Version: this.version, AppVersion: this.appVersion, Key: this.key };
  }

  // The 7.0.8 app sends only the DynaPath header on protected paths (no Sid
  // form field); keep generateSid available for the legacy parity test only.
  async _authHeadersAndSid(url) {
    const headers = { "User-Agent": USER_AGENT };
    if (DYNAPATH_PATHS.some((p) => url.includes(p))) {
      headers["x-dynapath-m-token"] = this.dyna.generateToken(this.deviceId, Date.now(), randomNonce());
    }
    return { headers, sid: null };
  }

  // Form POST, signed when the path needs DynaPath; optionally paced by the
  // NetFunnel queue gate. Returns the parsed reply (object, or raw text).
  async _post(url, form, { gate = null, encoded = false } = {}) {
    const { headers } = await this._authHeadersAndSid(url);
    const data = encoded ? encodeForm(form) : form;
    const send = () => this.http.request({ method: "POST", url, data, headers });
    const res = gate && this.queue ? await this.queue.run(gate, send) : await send();
    return res;
  }

  // Reject replies that are not a Korail envelope (anti-bot block, HTML).
  _envelope(res) {
    const data = res.data;
    if (!data || typeof data !== "object") throw new KorailError(excerpt(data, res.status), "NOENVELOPE");
    for (const v of Object.values(data)) {
      if (typeof v === "number" && Number.isInteger(v) && DYNAPATH_BLOCK_CODES.has(v)) {
        throw new KorailError(`코레일 봇 차단(DynaPath ${v}): ${data.message || ""}`.trim(), "DYNAPATH");
      }
    }
    return data;
  }

  async _loginKey() {
    // The app fetches the one-time password key with its common-code bootstrap.
    const form = Object.assign(this._common(), { code: COMMON_CODES, deviceWidth: 1440, deviceHeight: 3120, OSVersion: 37 });
    const res = await this._post(URLS.CODE, form, { encoded: true });
    const j = this._envelope(res);
    const info = j["app.login.cphd"];
    if (j.strResult === "SUCC" && info && info.key) {
      this.idx = info.idx != null ? String(info.idx) : null;
      return info.key;
    }
    throw new KorailError(j.h_msg_txt || "비밀번호 암호화 키를 발급받지 못했습니다", j.h_msg_cd);
  }

  async login(korailId, korailPw) {
    korailId = String(korailId || "").trim();
    // 5 = email, 4 = phone, 2 = membership number. The app sends phone numbers
    // as typed (digits); the server also accepts the hyphenated form.
    let inputFlag;
    if (EMAIL_REGEX.test(korailId)) inputFlag = "5";
    else if (PHONE_REGEX.test(korailId) || PHONE_DIGITS_REGEX.test(korailId)) inputFlag = "4";
    else inputFlag = "2";
    this.lastLoginMessage = null;
    this.lastLoginRaw = null;

    try {
      // Service status probe the app makes first (best effort).
      await this.http.request({ method: "POST", url: URLS.SERVICE, data: { timeStamp: String(Date.now()) }, headers: { "User-Agent": USER_AGENT } });
    } catch (_) { /* ignore */ }

    const encPw = await encryptPassword(korailPw, await this._loginKey());
    const form = Object.assign(this._common(), {
      txtInputFlg: inputFlag, txtMemberNo: korailId, txtPwd: encPw, checkValidPw: "Y",
    });
    if (this.idx) form.idx = this.idx;

    const res = await this._post(URLS.LOGIN, form);
    const data = res.data;
    const ok = data && typeof data === "object" &&
      (LOGIN_OK_CODES.has(data.h_msg_cd) || (data.strResult === "SUCC" && data.strMbCrdNo != null));
    if (ok) {
      if (data.Key) this.key = data.Key;
      this.membershipNumber = data.strMbCrdNo || null;
      this.custNo = data.strCustNo || null;
      this.name = data.strCustNm || null;
      this.logined = true;
      return true;
    }
    this.logined = false;
    // Surface the server's own reason (wrong password, locked account, app
    // update required, anti-bot block, ...) so the UI can show it.
    let why = (data && typeof data === "object" && (data.h_msg_txt || data.strMsg || data.message)) || null;
    if (!why) why = excerpt(data, res.status);
    else if (data.h_msg_cd) why = `${why} [${data.h_msg_cd}]`;
    this.lastLoginMessage = why;
    this.lastLoginRaw = data;
    return false;
  }

  async searchTrainDetails(dep, arr, date, time, {
    trainType = "100", passengers, includeNoSeats = false, includeWaitingList = false,
  } = {}) {
    const pax = passengers || buildPassengers();
    const c = pax.counts;
    const all = trainType === TRAIN_TYPES.all;
    const form = Object.assign(this._common(), {
      txtMenuId: "11",
      radJobId: "1",
      selGoTrain: trainType,
      txtTrnGpCd: trainType,
      txtGoStart: dep,
      txtGoEnd: arr,
      txtGoAbrdDt: date,
      txtGoHour: time,
      txtPsgFlg_1: String(c.adults || 0),
      txtPsgFlg_2: String((c.children || 0) + (c.toddlers || 0)),
      txtPsgFlg_3: String(c.seniors || 0),
      txtPsgFlg_4: "0",
      txtPsgFlg_5: "0",
      txtSeatAttCd_2: "000",
      txtSeatAttCd_3: "000",
      txtSeatAttCd_4: "015",
      ebizCrossCheck: all ? "Y" : "N", // 코레일+ : include SRT (수서고속) results
      srtCheckYn: all ? "Y" : "N",
      rtYn: "N",
      adjStnScdlOfrFlg: "N",
    });
    if (this.membershipNumber) form.mbCrdNo = this.membershipNumber;
    form.qryDvCd = "1";

    const res = await this._post(URLS.SEARCH, form, { gate: "inquiry" });
    const data = this._envelope(res);
    resultCheck(data);
    let infos = data.trn_infos && data.trn_infos.trn_info;
    if (!infos) throw new NoResultsError();
    if (!Array.isArray(infos)) infos = [infos];
    let trains = infos.map(parseTrain).filter((t) => t.dep_name === dep && t.arr_name === arr);
    trains = trains.filter((t) => {
      if (t.has_seat()) return true;
      if (includeNoSeats && !t.has_seat()) return true;
      if (includeWaitingList && t.has_waiting_list()) return true;
      return false;
    });
    if (trains.length === 0) throw new NoResultsError();
    return trains;
  }

  async searchTrain(dep, arr, date, time, opts) {
    return this.searchTrainDetails(dep, arr, date, time, opts);
  }

  async reserve(train, { passengers, option, seatOption, tryWaiting = false } = {}) {
    const SEAT_OPTION_MAP = {
      "general-first": RESERVE_OPTION.GENERAL_FIRST,
      "general-only": RESERVE_OPTION.GENERAL_ONLY,
      "special-first": RESERVE_OPTION.SPECIAL_FIRST,
      "special-only": RESERVE_OPTION.SPECIAL_ONLY,
    };
    if (!option) option = SEAT_OPTION_MAP[seatOption] || RESERVE_OPTION.GENERAL_FIRST;
    let reservingSeat = true;
    let seatType;
    try {
      if (!train.has_seat()) throw new SoldOutError();
      if (option === RESERVE_OPTION.GENERAL_ONLY) {
        if (train.has_general_seat()) seatType = "1";
        else throw new SoldOutError();
      } else if (option === RESERVE_OPTION.SPECIAL_ONLY) {
        if (train.has_special_seat()) seatType = "2";
        else throw new SoldOutError();
      } else if (option === RESERVE_OPTION.GENERAL_FIRST) {
        seatType = train.has_general_seat() ? "1" : "2";
      } else if (option === RESERVE_OPTION.SPECIAL_FIRST) {
        seatType = train.has_special_seat() ? "2" : "1";
      } else {
        throw new KorailError(`unsupported reserve option: ${option}`, null);
      }
    } catch (e) {
      if (e instanceof SoldOutError && tryWaiting && option !== RESERVE_OPTION.SPECIAL_ONLY && train.has_general_waiting_list()) {
        reservingSeat = false; // 예약대기 (standby hold, not payable)
        seatType = "1";
      } else {
        throw e;
      }
    }

    const pax = passengers || buildPassengers();
    const totalCount = pax.list.reduce((a, p) => a + p.count, 0);
    const form = Object.assign(this._common(), {
      txtMenuId: "11",
      txtJobId: reservingSeat ? "1101" : "1102",
      txtGdNo: "",
      hidFreeFlg: "N",
      txtStndFlg: "N",
      txtTotPsgCnt: String(totalCount),
    });
    pax.list.forEach((p, i) => {
      form["txtCompaCnt" + (i + 1)] = String(p.count);
      form["txtPsgTpCd" + (i + 1)] = p.typecode;
      form["txtDiscKndCd" + (i + 1)] = p.discount_type;
    });
    Object.assign(form, {
      txtSeatAttCd1: "000", txtSeatAttCd2: "000", txtSeatAttCd3: "000", txtSeatAttCd4: "015", txtSeatAttCd5: "000",
      txtPsrmClCd1: seatType,
      txtJrnyCnt: "1",
      txtJrnyTpCd1: "11",
      txtJrnySqno1: "001",
      txtTrnNo1: train.train_no,
      txtTrnClsfCd1: train.train_type,
      txtTrnGpCd1: train.train_group,
      txtRunDt1: train.run_date,
      txtDptDt1: train.dep_date,
      txtDptTm1: train.dep_time,
      txtDptRsStnCd1: train.dep_code,
      txtDptStnConsOrdr1: train.dep_cons_ordr || "",
      txtDptStnRunOrdr1: train.dep_run_ordr || "",
      txtArvRsStnCd1: train.arr_code,
      txtArvStnConsOrdr1: train.arr_cons_ordr || "",
      txtArvStnRunOrdr1: train.arr_run_ordr || "",
      txtChgFlg1: "N",
    });
    for (const k of Object.keys(form)) if (form[k] === "") delete form[k]; // the app omits empty fields

    const res = await this._post(URLS.RESERVE, form, { gate: "reserve" });
    const data = this._envelope(res);
    resultCheck(data);
    const reservationId = data.h_pnr_no;
    let all = [];
    try { all = await this.reservations(); } catch (_) { /* fall back to the hold reply */ }
    const match = all.filter((r) => r.reservation_id === reservationId);
    if (match.length === 1) return match[0];
    return {
      reservation_id: reservationId, train_no: train.train_no, train_type: train.train_type_name,
      dep_name: train.dep_name, dep_date: train.dep_date, dep_time: train.dep_time,
      arr_name: train.arr_name, arr_date: train.arr_date, arr_time: train.arr_time,
      seat_count: totalCount, price: parseInt(data.h_tot_prc || data.h_tot_fare || "0", 10),
      buy_limit_date: data.h_ntisu_lmt_dt, buy_limit_time: data.h_ntisu_lmt_tm,
      journey_no: "001", journey_cnt: data.h_jrny_cnt || "1", rsv_chg_no: "000",
      standby: !reservingSeat,
    };
  }

  async reservations() {
    const form = Object.assign(this._common(), { timeStamp: "0" });
    const res = await this._post(URLS.RESERVATIONS, form, { gate: "reservations" });
    const data = this._envelope(res);
    try {
      resultCheck(data);
    } catch (e) {
      if (e instanceof NoResultsError) return [];
      throw e;
    }
    const journeys = data.jrny_infos && data.jrny_infos.jrny_info;
    if (!journeys) return [];
    const out = [];
    for (const j of Array.isArray(journeys) ? journeys : [journeys]) {
      let infos = j.train_infos && j.train_infos.train_info;
      if (!infos) continue;
      for (const info of Array.isArray(infos) ? infos : [infos]) out.push(parseReservation(info, data));
    }
    return out;
  }

  // Unified interface shared with the bus clients (used by macro.js / app.js).
  findTrainById(trains, id) {
    return findTrainById(trains, id);
  }
  buildTrainId(train) {
    return buildTrainId(train);
  }
  makePassengers(opts) {
    return buildPassengers(opts);
  }

  async cancel(reservation) {
    const form = Object.assign(this._common(), {
      txtPnrNo: reservation.reservation_id,
      txtJrnySqno: reservation.journey_no,
      txtJrnyCnt: reservation.journey_cnt,
      hidRsvChgNo: reservation.rsv_chg_no,
    });
    const res = await this._post(URLS.CANCEL, form);
    resultCheck(this._envelope(res));
    return true;
  }
}

export { buildPassengers, findTrainById, parseTrain, trainIdFields };
