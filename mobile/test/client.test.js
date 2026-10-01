// Verifies korail.js wiring (login -> search -> reserve -> reservations) with a
// mocked HTTP adapter returning canned Korail JSON, plus train_id parity with
// the Python build_train_id.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Korail, buildTrainId, parseTrain, buildPassengers } from "../src/korail/korail.js";

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(execFileSync("python3", [join(here, "reference.py")], { encoding: "utf-8" }));

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

test("login sends encrypted password + idx and captures Key", async () => {
  const http = mockHttp([
    ["common.code.do", { strResult: "SUCC", "app.login.cphd": { idx: "77", key: "0123456789abcdef" } }],
    ["login.Login", (req) => {
      assert.equal(req.data.idx, "77");
      assert.ok(req.data.txtPwd && req.data.txtPwd.length > 0);
      assert.ok(req.headers["x-dynapath-m-token"], "login must carry dynapath token");
      assert.ok(req.data.Sid, "login must carry Sid");
      return { strResult: "SUCC", strMbCrdNo: "123456", strCustNm: "홍길동", Key: "KEY-ABC" };
    }],
  ]);
  const k = new Korail(http);
  const ok = await k.login("010-1234-5678", "pw!");
  assert.equal(ok, true);
  assert.equal(k.key, "KEY-ABC");
  assert.equal(k.logined, true);
});

test("search parses trains and filters by station + seat", async () => {
  const trainInfo = { ...ref.sampleTrain };
  const soldOut = { ...ref.sampleTrain, h_dpt_tm: "100000", h_gen_rsv_cd: "13" };
  const http = mockHttp([
    ["seatMovie.ScheduleView", {
      strResult: "SUCC",
      trn_infos: { trn_info: [trainInfo, soldOut] },
    }],
  ]);
  const k = new Korail(http);
  k.key = "KEY";
  const trains = await k.searchTrain("서울", "부산", "20260801", "090000", { trainType: "100" });
  assert.equal(trains.length, 1); // sold-out one filtered out by default
  assert.equal(trains[0].dep_time, "090000");
  assert.equal(trains[0].has_general_seat(), true);
});

test("reserve posts seat payload and returns the reloaded reservation", async () => {
  const http = mockHttp([
    ["certification.TicketReservation", (req) => {
      assert.equal(req.data ? undefined : req.params.txtJobId, "1101"); // seat reservation
      assert.equal(req.params.txtTrnNo1, "101");
      assert.equal(req.params.txtPsrmClCd1, "1"); // general
      assert.ok(req.headers["x-dynapath-m-token"]);
      return { strResult: "SUCC", h_pnr_no: "PNR123" };
    }],
    ["reservation.ReservationView", {
      strResult: "SUCC",
      jrny_infos: { jrny_info: [{ train_infos: { train_info: [{
        h_pnr_no: "PNR123", h_trn_no: "101", h_trn_clsf_nm: "KTX",
        h_dpt_rs_stn_nm: "서울", h_arv_rs_stn_nm: "부산", h_run_dt: "20260801",
        h_dpt_tm: "090000", h_arv_tm: "115300", h_tot_seat_cnt: "1",
        h_rsv_amt: "59800", h_ntisu_lmt_dt: "20260801", h_ntisu_lmt_tm: "093000",
      }] } }] },
    }],
  ]);
  const k = new Korail(http);
  k.key = "KEY";
  const train = parseTrain(ref.sampleTrain);
  const rsv = await k.reserve(train, { passengers: buildPassengers({ adults: 1 }) });
  assert.equal(rsv.reservation_id, "PNR123");
  assert.equal(rsv.price, 59800);
  assert.equal(rsv.buy_limit_time, "093000");
});

test("reservations() normalizes pending reservations (구입기한/금액)", async () => {
  const http = mockHttp([
    ["reservation.ReservationView", {
      strResult: "SUCC",
      jrny_infos: { jrny_info: [{ train_infos: { train_info: [{
        h_pnr_no: "PNR777", h_trn_no: "123", h_trn_clsf_nm: "KTX",
        h_dpt_rs_stn_nm: "서울", h_arv_rs_stn_nm: "부산", h_run_dt: "20260901",
        h_dpt_tm: "080000", h_arv_tm: "103000", h_tot_seat_cnt: "2",
        h_rsv_amt: "119600", h_ntisu_lmt_dt: "20260831", h_ntisu_lmt_tm: "230000",
        txtJrnySqno: "001", txtJrnyCnt: "01",
      }] } }] },
    }],
  ]);
  const k = new Korail(http);
  k.key = "KEY";
  const list = await k.reservations();
  assert.equal(list.length, 1);
  assert.equal(list[0].reservation_id, "PNR777");
  assert.equal(list[0].price, 119600);
  assert.equal(list[0].seat_count, 2);
  assert.equal(list[0].buy_limit_date, "20260831");
  assert.equal(list[0].buy_limit_time, "230000");
  assert.equal(list[0].journey_no, "001");
});

test("cancel() sends the reservation identifiers and succeeds", async () => {
  const http = mockHttp([
    ["reservationCancel.ReservationCancelChk", (req) => {
      assert.equal(req.params.txtPnrNo, "PNR777");
      assert.equal(req.params.txtJrnySqno, "001");
      assert.equal(req.params.txtJrnyCnt, "01");
      return { strResult: "SUCC" };
    }],
  ]);
  const k = new Korail(http);
  k.key = "KEY";
  const ok = await k.cancel({ reservation_id: "PNR777", journey_no: "001", journey_cnt: "01", rsv_chg_no: "00000" });
  assert.equal(ok, true);
});

test("login: digits-only phone id is sent hyphenated as type 4; failure keeps server message", async () => {
  let sent = null;
  const http = mockHttp([
    ["common.code.do", { strResult: "SUCC", "app.login.cphd": { idx: "77", key: "0123456789abcdef" } }],
    ["login.Login", (req) => { sent = req.data; return { strResult: "FAIL", h_msg_cd: "P058", h_msg_txt: "비밀번호가 일치하지 않습니다." }; }],
  ]);
  const k = new Korail(http);
  const ok = await k.login("01012345678", "pw!");
  assert.equal(ok, false);
  assert.equal(sent.txtInputFlg, "4");
  assert.equal(sent.txtMemberNo, "010-1234-5678");
  assert.match(k.lastLoginMessage, /^비밀번호가 일치하지 않습니다\. \[P058\]$/);
});

test("login: non-envelope reply (anti-bot block / HTML) is surfaced verbatim", async () => {
  const http = mockHttp([
    ["common.code.do", { strResult: "SUCC", "app.login.cphd": { idx: "77", key: "0123456789abcdef" } }],
    ["login.Login", () => ({ code: -8201, message: "MACRO ERROR" })],
  ]);
  const k = new Korail(http);
  assert.equal(await k.login("1234567890", "pw!"), false);
  assert.equal(k.lastLoginMessage, "MACRO ERROR");
  const html = mockHttp([
    ["common.code.do", { strResult: "SUCC", "app.login.cphd": { idx: "77", key: "0123456789abcdef" } }],
    ["login.Login", () => "<html><body><h1>접근이 차단되었습니다</h1></body></html>"],
  ]);
  const k2 = new Korail(html);
  assert.equal(await k2.login("1234567890", "pw!"), false);
  assert.match(k2.lastLoginMessage, /코레일 봉투가 아닌 응답 \(HTTP 200\): 접근이 차단되었습니다/);
});
