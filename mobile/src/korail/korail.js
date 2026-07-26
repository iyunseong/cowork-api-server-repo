// On-device Korail client — a JS port of the PatchedKorail helper in
// ktx/ktx_booking.py (which itself patches korail2 for the Dynapath anti-bot
// check). Runs entirely on the phone; talks to Korail's mobile API directly.
//
// The crypto/token pieces (dynapath, sid, password) are byte-for-byte verified
// against the Python reference in mobile/test/parity.test.js.
//
// An `http` adapter must be injected: http.request({ method, url, params, data,
// headers }) -> Promise<{ status, data }> where data is the parsed JSON body.
// In the app this is backed by CapacitorHttp (native requests share the WebView
// cookie store, so Korail's session cookies persist across calls).

import { DynaPath } from "./dynapath.js";
import { generateSid, encryptPassword } from "./crypto.js";
import { resultCheck, NeedToLoginError, NoResultsError, SoldOutError, KorailError } from "./errors.js";

const BASE = "https://smart.letskorail.com:443/classes/com.korail.mobile.";
export const URLS = {
  CODE: BASE + "common.code.do",
  LOGIN: BASE + "login.Login",
  SEARCH: BASE + "seatMovie.ScheduleView",
  RESERVE: BASE + "certification.TicketReservation",
  RESERVATIONS: BASE + "reservation.ReservationView",
  CANCEL: BASE + "reservationCancel.ReservationCancelChk",
};

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

const USER_AGENT = "Dalvik/2.1.0 (Linux; U; Android 13; SM-S928N Build/UP1A.231005.007)";
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

function parseReservation(d) {
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
    journey_no: d.txtJrnySqno || "001",
    journey_cnt: d.txtJrnyCnt || "01",
    rsv_chg_no: d.hidRsvChgNo || "00000",
  };
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

function randomNonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export class Korail {
  constructor(http, { appStartTs } = {}) {
    this.http = http;
    this.device = "AD";
    this.version = "250601002";
    this.deviceId = "558a4f02041657ea";
    this.dyna = new DynaPath(appStartTs || Date.now());
    this.key = null;
    this.idx = null;
    this.logined = false;
    this.membershipNumber = null;
    this.name = null;
  }

  async _authHeadersAndSid(url) {
    const headers = { "User-Agent": USER_AGENT };
    let sid = null;
    if (DYNAPATH_PATHS.some((p) => url.includes(p))) {
      const ts = Date.now();
      const nonce = randomNonce();
      headers["x-dynapath-m-token"] = this.dyna.generateToken(this.deviceId, ts, nonce);
      sid = await generateSid(ts, this.device);
    }
    return { headers, sid };
  }

  async _encPassword(password) {
    // KORAIL_CODE returns { idx, key }; encrypt the password with it.
    const res = await this.http.request({
      method: "POST",
      url: URLS.CODE,
      data: { code: "app.login.cphd" },
      headers: { "User-Agent": USER_AGENT },
    });
    const j = res.data;
    const info = j && j["app.login.cphd"];
    if (j.strResult === "SUCC" && info) {
      this.idx = info.idx;
      return await encryptPassword(password, info.key);
    }
    throw new KorailError("failed to fetch login key", j && j.h_msg_cd);
  }

  async login(korailId, korailPw) {
    let inputFlag;
    if (EMAIL_REGEX.test(korailId)) inputFlag = "5";
    else if (PHONE_REGEX.test(korailId) || PHONE_DIGITS_REGEX.test(korailId)) inputFlag = "4";
    else inputFlag = "2";

    const encPw = await this._encPassword(korailPw);
    const { headers, sid } = await this._authHeadersAndSid(URLS.LOGIN);
    const payload = {
      Device: this.device,
      Version: this.version,
      txtInputFlg: inputFlag,
      txtMemberNo: korailId,
      txtPwd: encPw,
      idx: this.idx,
    };
    if (sid) payload.Sid = sid;

    const res = await this.http.request({ method: "POST", url: URLS.LOGIN, data: payload, headers });
    const data = res.data;
    if (data.strResult === "SUCC" && data.strMbCrdNo != null) {
      this.key = data.Key;
      this.membershipNumber = data.strMbCrdNo;
      this.name = data.strCustNm;
      this.logined = true;
      return true;
    }
    this.logined = false;
    return false;
  }

  async searchTrainDetails(dep, arr, date, time, {
    trainType = "100", passengers, includeNoSeats = false, includeWaitingList = false,
  } = {}) {
    const pax = passengers || buildPassengers();
    const c = pax.counts;
    const { headers, sid } = await this._authHeadersAndSid(URLS.SEARCH);
    const payload = {
      Device: this.device,
      radJobId: "1",
      selGoTrain: trainType,
      txtCardPsgCnt: "0",
      txtGdNo: "",
      txtGoAbrdDt: date,
      txtGoEnd: arr,
      txtGoHour: time,
      txtGoStart: dep,
      txtJobDv: "",
      txtMenuId: "11",
      txtPsgFlg_1: c.adults || 0,
      txtPsgFlg_2: c.children || 0,
      txtPsgFlg_8: c.toddlers || 0,
      txtPsgFlg_3: c.seniors || 0,
      txtPsgFlg_4: "0",
      txtPsgFlg_5: "0",
      txtSeatAttCd_2: "000",
      txtSeatAttCd_3: "000",
      txtSeatAttCd_4: "015",
      txtTrnGpCd: trainType,
      Version: this.version,
    };
    if (sid) payload.Sid = sid;

    const res = await this.http.request({ method: "POST", url: URLS.SEARCH, params: payload, headers });
    const data = res.data;
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

  async reserve(train, { passengers, option = RESERVE_OPTION.GENERAL_FIRST, tryWaiting = false } = {}) {
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
        reservingSeat = false;
        seatType = "1";
      } else {
        throw e;
      }
    }

    const pax = passengers || buildPassengers();
    const totalCount = pax.list.reduce((a, p) => a + p.count, 0);
    const { headers, sid } = await this._authHeadersAndSid(URLS.RESERVE);
    const payload = {
      Device: this.device,
      Version: this.version,
      Key: this.key,
      txtGdNo: "",
      txtJobId: reservingSeat ? "1101" : "1102",
      txtTotPsgCnt: totalCount,
      txtSeatAttCd1: "000",
      txtSeatAttCd2: "000",
      txtSeatAttCd3: "000",
      txtSeatAttCd4: "015",
      txtSeatAttCd5: "000",
      hidFreeFlg: "N",
      txtStndFlg: "N",
      txtMenuId: "11",
      txtSrcarCnt: "0",
      txtJrnyCnt: "1",
      txtJrnySqno1: "001",
      txtJrnyTpCd1: "11",
      txtDptDt1: train.dep_date,
      txtDptRsStnCd1: train.dep_code,
      txtDptTm1: train.dep_time,
      txtArvRsStnCd1: train.arr_code,
      txtTrnNo1: train.train_no,
      txtRunDt1: train.run_date,
      txtTrnClsfCd1: train.train_type,
      txtPsrmClCd1: seatType,
      txtTrnGpCd1: train.train_group,
      txtChgFlg1: "",
      txtJrnySqno2: "",
      txtJrnyTpCd2: "",
      txtDptDt2: "",
      txtDptRsStnCd2: "",
      txtDptTm2: "",
      txtArvRsStnCd2: "",
      txtTrnNo2: "",
      txtRunDt2: "",
      txtTrnClsfCd2: "",
      txtPsrmClCd2: "",
      txtChgFlg2: "",
    };
    if (sid) payload.Sid = sid;
    pax.list.forEach((p, i) => Object.assign(payload, passengerGetDict(p, i + 1)));

    const res = await this.http.request({ method: "GET", url: URLS.RESERVE, params: payload, headers });
    const data = res.data;
    resultCheck(data);
    const reservationId = data.h_pnr_no;
    const all = await this.reservations();
    const match = all.filter((r) => r.reservation_id === reservationId);
    if (match.length === 1) return match[0];
    throw new KorailError(`reservation ${reservationId} created but could not be reloaded`, null);
  }

  async reservations() {
    const payload = { Device: this.device, Version: this.version, Key: this.key };
    const res = await this.http.request({
      method: "GET", url: URLS.RESERVATIONS, params: payload,
      headers: { "User-Agent": USER_AGENT },
    });
    const data = res.data;
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
      for (const info of Array.isArray(infos) ? infos : [infos]) out.push(parseReservation(info));
    }
    return out;
  }

  async cancel(reservation) {
    const payload = {
      Device: this.device,
      Version: this.version,
      Key: this.key,
      txtPnrNo: reservation.reservation_id,
      txtJrnySqno: reservation.journey_no,
      txtJrnyCnt: reservation.journey_cnt,
      hidRsvChgNo: reservation.rsv_chg_no,
    };
    const res = await this.http.request({
      method: "GET", url: URLS.CANCEL, params: payload,
      headers: { "User-Agent": USER_AGENT },
    });
    resultCheck(res.data);
    return true;
  }
}

export { buildPassengers, findTrainById, parseTrain, trainIdFields };
