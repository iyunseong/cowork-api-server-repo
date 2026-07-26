// Drives runMacro against the mocked Korail client: sold-out first, seat later.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { Korail, parseTrain, buildTrainId, buildPassengers } from "../src/korail/korail.js";
import { runMacro } from "../src/macro.js";

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(execFileSync("python3", [join(here, "reference.py")], { encoding: "utf-8" }));

function seatState(hasSeat) {
  return { ...ref.sampleTrain, h_gen_rsv_cd: hasSeat ? "11" : "13" };
}

// Korail client whose search returns sold-out for the first N calls, then a seat.
function clientThatOpensAfter(n) {
  let searchCalls = 0;
  const http = {
    async request(req) {
      if (req.url.includes("ScheduleView")) {
        searchCalls += 1;
        const hasSeat = searchCalls > n;
        return { status: 200, data: { strResult: "SUCC", trn_infos: { trn_info: [seatState(hasSeat)] } } };
      }
      if (req.url.includes("TicketReservation")) {
        return { status: 200, data: { strResult: "SUCC", h_pnr_no: "PNR999" } };
      }
      if (req.url.includes("ReservationView")) {
        return { status: 200, data: { strResult: "SUCC", jrny_infos: { jrny_info: [{ train_infos: { train_info: [{
          h_pnr_no: "PNR999", h_trn_no: "101", h_trn_clsf_nm: "KTX", h_dpt_rs_stn_nm: "서울",
          h_arv_rs_stn_nm: "부산", h_run_dt: "20260801", h_dpt_tm: "090000", h_arv_tm: "115300",
          h_tot_seat_cnt: "1", h_rsv_amt: "59800", h_ntisu_lmt_dt: "20260801", h_ntisu_lmt_tm: "093000",
        }] } }] } } };
      }
      throw new Error("no mock: " + req.url);
    },
  };
  const k = new Korail(http);
  k.key = "KEY";
  k.logined = true;
  return k;
}

test("auto mode retries while sold out then reserves", async () => {
  const korail = clientThatOpensAfter(2); // sold out for 2 searches, seat on 3rd
  const updates = [];
  const result = await runMacro(
    { korail, dep: "서울", arr: "부산", date: "20260801", time: "090000", trainType: "100", passengers: buildPassengers({ adults: 1 }), intervalMs: 1 },
    { onUpdate: (u) => updates.push(u), sleep: async () => {} }
  );
  assert.equal(result.status, "reserved");
  assert.equal(result.reservation.reservation_id, "PNR999");
  assert.ok(result.attempts >= 3, "should have retried until a seat opened");
});

test("specific-train mode reserves the matching train_id", async () => {
  const korail = clientThatOpensAfter(0); // seat immediately
  const trainId = buildTrainId(parseTrain(seatState(true)));
  const result = await runMacro(
    { korail, dep: "서울", arr: "부산", date: "20260801", time: "090000", trainType: "100", trainId, passengers: buildPassengers({ adults: 1 }), intervalMs: 1 },
    { sleep: async () => {} }
  );
  assert.equal(result.status, "reserved");
  assert.equal(result.reservation.price, 59800);
});

test("shouldStop halts the loop", async () => {
  const korail = clientThatOpensAfter(1000); // never opens
  let ticks = 0;
  const result = await runMacro(
    { korail, dep: "서울", arr: "부산", date: "20260801", time: "090000", trainType: "100", passengers: buildPassengers(), intervalMs: 1 },
    { sleep: async () => {}, shouldStop: () => ++ticks > 3 }
  );
  assert.equal(result.status, "stopped");
});
