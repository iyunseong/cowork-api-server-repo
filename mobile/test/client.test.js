// Verifies korail.js wiring (login -> search -> reserve -> reservations -> cancel)
// with a mocked HTTP adapter returning canned Korail JSON, the request forms
// against korail-mobile-api's builders, and train_id parity with build_train_id.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Korail, buildTrainId, parseTrain, buildPassengers } from "../src/korail/korail.js";
import { parseQueueReply } from "../src/korail/netfunnel.js";

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(execFileSync("python3", [join(here, "reference.py")], { encoding: "utf-8" }));

const CPHD = { strResult: "SUCC", "app.login.cphd": { idx: "77", key: "0123456789abcdef" } };
const noEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ""));

test("train_id matches Python build_train_id", () => {
  const train = parseTrain(ref.sampleTrain);
  assert.equal(buildTrainId(train), ref.trainId);
});

// A scripted HTTP adapter: each call matched by URL substring.
function mockHttp(routes) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      for (const [needle, responder] of routes) {
        if (req.url.includes(needle)) {
          const data = typeof responder === "function" ? responder(req) : responder;
          return { status: 200, data };
        }
      }
      throw new Error("no mock for " + req.url);
    },
  };
}
const client = (http, opts = {}) => new Korail(http, Object.assign({ queue: false }, opts));

test("login: service probe → common-code key → signed login form; success by h_msg_cd", async () => {
  const http = mockHttp([
    ["MobileService.cache", { strResult: "SUCC" }],
    ["common.code.do", (req) => {
      assert.equal(typeof req.data, "string"); // repeated code= keys need a pre-encoded body
      assert.match(req.data, /Device=AD&Version=250601003&AppVersion=7\.0\.8&Key=korail1234567890&code=app\.display\.image&/);
      assert.match(req.data, /code=app\.login\.cphd/);
      assert.match(req.data, /deviceWidth=1440&deviceHeight=3120&OSVersion=37/);
      return CPHD;
    }],
    ["login.Login", (req) => {
      assert.equal(req.data.Version, "250601003");
      assert.equal(req.data.AppVersion, "7.0.8");
      assert.equal(req.data.Key, "korail1234567890");
      assert.equal(req.data.txtInputFlg, "4");
      assert.equal(req.data.txtMemberNo, "010-1234-5678");
      assert.equal(req.data.checkValidPw, "Y");
      assert.equal(req.data.idx, "77");
      assert.match(req.data.txtPwd, /\n$/); // app-style wrapped base64
      assert.ok(req.headers["x-dynapath-m-token"], "login must carry dynapath token");
      assert.ok(req.data.Sid, "login must carry Sid");
      assert.equal(req.headers["User-Agent"], "korailtalk");
      return { strResult: "SUCC", h_msg_cd: "IRZ000001", strMbCrdNo: "1234567890", strCustNm: "홍길동", strCustNo: "C1" };
    }],
  ]);
  const k = client(http);
  assert.equal(await k.login("010-1234-5678", "pw!"), true);
  assert.equal(k.logined, true);
  assert.equal(k.membershipNumber, "1234567890");
  assert.deepEqual(http.calls.map((c) => c.url.split("/").pop()), ["MobileService.cache", "com.korail.mobile.common.code.do", "com.korail.mobile.login.Login"]);
});

test("login: id kinds (digits phone / member no / email) and server failure reasons", async () => {
  const seen = [];
  const http = mockHttp([
    ["MobileService.cache", {}], ["common.code.do", CPHD],
    ["login.Login", (req) => { seen.push([req.data.txtInputFlg, req.data.txtMemberNo]); return { strResult: "FAIL", h_msg_cd: "P058", h_msg_txt: "비밀번호가 일치하지 않습니다." }; }],
  ]);
  const k = client(http);
  assert.equal(await k.login("01012345678", "pw!"), false);
  assert.equal(k.lastLoginMessage, "비밀번호가 일치하지 않습니다. [P058]");
  await k.login("1234567890", "pw!");
  await k.login("me@example.com", "pw!");
  assert.deepEqual(seen, [["4", "01012345678"], ["2", "1234567890"], ["5", "me@example.com"]]);
});

test("login: non-envelope reply (anti-bot block / HTML) is surfaced verbatim", async () => {
  const http = mockHttp([["MobileService.cache", {}], ["common.code.do", CPHD], ["login.Login", () => ({ code: -8201, message: "MACRO ERROR" })]]);
  const k = client(http);
  assert.equal(await k.login("1234567890", "pw!"), false);
  assert.equal(k.lastLoginMessage, "MACRO ERROR");
  const html = mockHttp([["MobileService.cache", {}], ["common.code.do", CPHD], ["login.Login", () => "<html><body><h1>접근이 차단되었습니다</h1></body></html>"]]);
  const k2 = client(html);
  assert.equal(await k2.login("1234567890", "pw!"), false);
  assert.match(k2.lastLoginMessage, /코레일 봉투가 아닌 응답 \(HTTP 200\): 접근이 차단되었습니다/);
});

test("search form matches korail-mobile-api build_train_search_form; rows parsed and filtered", async () => {
  const trainInfo = { ...ref.sampleTrain };
  const soldOut = { ...ref.sampleTrain, h_dpt_tm: "100000", h_gen_rsv_cd: "13" };
  let form = null;
  const http = mockHttp([
    ["seatMovie.ScheduleView", (req) => {
      form = req.data;
      assert.ok(req.headers["x-dynapath-m-token"]);
      return { strResult: "SUCC", trn_infos: { trn_info: [trainInfo, soldOut] } };
    }],
  ]);
  const k = client(http);
  const trains = await k.searchTrain("서울", "부산", "20260801", "090000", { trainType: "100" });
  const { Sid, ...sent } = form;
  assert.ok(Sid);
  assert.deepEqual(sent, ref.forms.searchNoMember);
  assert.equal(trains.length, 1); // sold-out one filtered out by default
  assert.equal(trains[0].has_general_seat(), true);

  k.membershipNumber = "1234567890";
  await k.searchTrain("서울", "부산", "20260801", "090000", {
    trainType: "109", passengers: buildPassengers({ adults: 2, children: 1, seniors: 1 }), includeNoSeats: true,
  });
  const { Sid: s2, ...sent2 } = form;
  assert.deepEqual(sent2, ref.forms.search); // 전체 → SRT included (ebizCrossCheck/srtCheckYn=Y), mbCrdNo carried
});

test("search: DynaPath block reply becomes a typed error instead of a silent empty list", async () => {
  const http = mockHttp([["seatMovie.ScheduleView", () => ({ code: -8201, message: "MACRO ERROR" })]]);
  await assert.rejects(() => client(http).searchTrain("서울", "부산", "20260801", "090000"), /코레일 봇 차단\(DynaPath -8201\): MACRO ERROR/);
});

test("reserve form matches korail-mobile-api build_reservation_form; returns the reloaded reservation", async () => {
  let form = null;
  const http = mockHttp([
    ["certification.TicketReservation", (req) => {
      form = req.data;
      assert.ok(req.headers["x-dynapath-m-token"]);
      return { strResult: "SUCC", h_pnr_no: "PNR123", h_jrny_cnt: "1" };
    }],
    ["reservation.ReservationView", (req) => {
      assert.equal(req.data.timeStamp, "0");
      assert.equal(req.data.Key, "korail1234567890");
      return {
        strResult: "SUCC", h_jrny_cnt: "1",
        jrny_infos: { jrny_info: [{ train_infos: { train_info: [{
          h_pnr_no: "PNR123", h_trn_no: "101", h_trn_clsf_nm: "KTX",
          h_dpt_rs_stn_nm: "서울", h_arv_rs_stn_nm: "부산", h_run_dt: "20260801",
          h_dpt_tm: "090000", h_arv_tm: "115300", h_tot_seat_cnt: "1",
          h_rsv_amt: "59800", h_ntisu_lmt_dt: "20260801", h_ntisu_lmt_tm: "093000", h_jrny_sqno: "001",
        }] } }] },
      };
    }],
  ]);
  const k = client(http);
  const train = parseTrain(ref.sampleTrainFull);
  const rsv = await k.reserve(train, { passengers: buildPassengers({ adults: 1 }) });
  const { Sid, ...sent } = form;
  assert.ok(Sid);
  assert.deepEqual(sent, noEmpty(ref.forms.reserve));
  assert.equal(rsv.reservation_id, "PNR123");
  assert.equal(rsv.price, 59800);
  assert.equal(rsv.buy_limit_time, "093000");
  assert.equal(rsv.journey_cnt, "1");
});

test("reserve: standby (예약대기) uses job 1102 when no seat but waiting list is open", async () => {
  let form = null;
  const http = mockHttp([
    ["certification.TicketReservation", (req) => { form = req.data; return { strResult: "SUCC", h_pnr_no: "PNRW", h_ntisu_lmt_dt: "20260801", h_ntisu_lmt_tm: "100000" }; }],
    ["reservation.ReservationView", { strResult: "FAIL", h_msg_cd: "P100" }],
  ]);
  const train = parseTrain({ ...ref.sampleTrainFull, h_gen_rsv_cd: "13", h_wait_rsv_flg: "9" });
  const rsv = await client(http).reserve(train, { tryWaiting: true });
  assert.equal(form.txtJobId, "1102");
  assert.equal(rsv.reservation_id, "PNRW"); // built from the hold reply when the list is empty
  assert.equal(rsv.standby, true);
});

test("reservations() normalizes pending reservations (구입기한/금액/여정번호)", async () => {
  const http = mockHttp([
    ["reservation.ReservationView", {
      strResult: "SUCC", h_jrny_cnt: "2",
      jrny_infos: { jrny_info: [{ train_infos: { train_info: [{
        h_pnr_no: "PNR777", h_trn_no: "123", h_trn_clsf_nm: "KTX",
        h_dpt_rs_stn_nm: "서울", h_arv_rs_stn_nm: "부산", h_run_dt: "20260901",
        h_dpt_tm: "080000", h_arv_tm: "103000", h_tot_seat_cnt: "2",
        h_rsv_amt: "119600", h_ntisu_lmt_dt: "20260831", h_ntisu_lmt_tm: "230000", h_jrny_sqno: "002",
      }] } }] },
    }],
  ]);
  const list = await client(http).reservations();
  assert.equal(list.length, 1);
  assert.equal(list[0].reservation_id, "PNR777");
  assert.equal(list[0].price, 119600);
  assert.equal(list[0].seat_count, 2);
  assert.equal(list[0].buy_limit_date, "20260831");
  assert.equal(list[0].journey_no, "002");
  assert.equal(list[0].journey_cnt, "2");
  assert.equal(list[0].rsv_chg_no, "000");
});

test("cancel() posts the reservation identifiers with the common fields", async () => {
  const http = mockHttp([
    ["reservationCancel.ReservationCancelChk", (req) => {
      assert.equal(req.data.txtPnrNo, "PNR777");
      assert.equal(req.data.txtJrnySqno, "002");
      assert.equal(req.data.txtJrnyCnt, "2");
      assert.equal(req.data.hidRsvChgNo, "000");
      assert.equal(req.data.AppVersion, "7.0.8");
      return { strResult: "SUCC" };
    }],
  ]);
  const ok = await client(http).cancel({ reservation_id: "PNR777", journey_no: "002", journey_cnt: "2", rsv_chg_no: "000" });
  assert.equal(ok, true);
});

test("queue gate: 5101 → wait → 5002 → request → 5004; failures bypass", async () => {
  assert.deepEqual(parseQueueReply("201:key=K1&nwait=3&ttl=1&ip=1.2.3.4&port=80"), { code: "201", key: "K1", params: { key: "K1", nwait: "3", ttl: "1", ip: "1.2.3.4", port: "80" }, raw: "201:key=K1&nwait=3&ttl=1&ip=1.2.3.4&port=80" });
  const ops = [];
  const http = mockHttp([
    ["nf.letskorail.com", (req) => { ops.push(req.params.opcode); return req.params.opcode === "5101" ? "201:key=K1&ttl=1" : req.params.opcode === "5002" ? "200:key=K1" : "200:"; }],
    ["seatMovie.ScheduleView", { strResult: "SUCC", trn_infos: { trn_info: [ref.sampleTrain] } }],
  ]);
  const k = new Korail(http);
  k.queue.sleep = async () => {};
  const trains = await k.searchTrain("서울", "부산", "20260801", "090000");
  assert.equal(trains.length, 1);
  assert.deepEqual(ops, ["5101", "5002", "5004"]);
  assert.equal(k.queue.lastDiag, "queue inquiry: 200");

  const down = mockHttp([
    ["nf.letskorail.com", () => { throw new Error("offline"); }],
    ["seatMovie.ScheduleView", { strResult: "SUCC", trn_infos: { trn_info: [ref.sampleTrain] } }],
  ]);
  const k2 = new Korail(down);
  assert.equal((await k2.searchTrain("서울", "부산", "20260801", "090000")).length, 1);
  assert.match(k2.queue.lastDiag, /bypass/);
});
