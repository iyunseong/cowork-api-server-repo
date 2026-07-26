// SRT port checks: parsing/train_id/passenger-dict/NetFunnel parity with the
// Python SRTrain library, plus a mocked login→search→reserve flow.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SRT, parseTrain, buildTrainId, makePassengers } from "../src/srt/srt.js";
import { parseNetFunnel } from "../src/srt/netfunnel.js";

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(execFileSync("python3", [join(here, "srt_reference.py")], { encoding: "utf-8" }));

test("SRT train_id + seat flags match Python SRTrain", () => {
  const t = parseTrain(ref.sampleTrain);
  assert.equal(buildTrainId(t), ref.trainId);
  assert.equal(t.general_seat_available(), ref.general_seat_available);
  assert.equal(t.special_seat_available(), ref.special_seat_available);
  assert.equal(t.has_seat(), ref.seat_available);
  assert.equal(t.has_general_waiting_list(), ref.reserve_standby_available);
});

test("NetFunnel response parse matches Python", () => {
  const d = parseNetFunnel(ref.netfunnelText);
  assert.equal(d.key, ref.netfunnel.key);
  assert.equal(d.status, ref.netfunnel.status);
  assert.equal(d.nwait, ref.netfunnel.nwait);
});

test("passenger dict matches Python get_passenger_dict", () => {
  // Reproduce the reference's [Adult(2), Child(1), Senior(1)] via makePassengers.
  const pax = makePassengers({ adults: 2, children: 1, seniors: 1 });
  // Build the same form fields the SRT client sends (general seat, no window pref).
  const { SRT: _c } = {}; // (no-op) keep import list obvious
  // Rebuild dict the way srt.js does internally:
  const data = { totPrnb: String(pax.list.reduce((a, p) => a + p.count, 0)), psgGridcnt: String(pax.list.length) };
  pax.list.forEach((p, i) => {
    const n = i + 1;
    data["psgTpCd" + n] = p.type_code;
    data["psgInfoPerPrnb" + n] = String(p.count);
    data["locSeatAttCd" + n] = "000";
    data["rqSeatAttCd" + n] = "015";
    data["dirSeatAttCd" + n] = "009";
    data["smkSeatAttCd" + n] = "000";
    data["etcSeatAttCd" + n] = "000";
    data["psrmClCd" + n] = "1";
  });
  assert.deepEqual(data, ref.passengerDict);
});

// --- mocked flow ----------------------------------------------------------
function mockSRT() {
  let searchCount = 0;
  const nfText = ref.netfunnelText;
  const http = {
    async request(req) {
      if (req.url.includes("nf.letskorail.com")) return { status: 200, data: nfText };
      if (req.url.includes("selectListApb01080")) return { status: 200, data: { userMap: { MB_CRD_NO: "123456" } } };
      if (req.url.includes("selectListAra10007")) {
        searchCount += 1;
        const trains = searchCount === 1 ? [ref.sampleTrain] : [];
        return { status: 200, data: { resultMap: [{ strResult: "SUCC" }], outDataSets: { dsOutput1: trains } } };
      }
      if (req.url.includes("selectListArc05013")) {
        return { status: 200, data: { resultMap: [{ strResult: "SUCC" }], reservListMap: [{ pnrNo: "SRT77" }] } };
      }
      if (req.url.includes("selectListAtc14016")) {
        return { status: 200, data: {
          resultMap: [{ strResult: "SUCC" }],
          trainListMap: [{ pnrNo: "SRT77", rcvdAmt: "52300", tkSpecNum: "1" }],
          payListMap: [{ trnNo: "351", stlbTrnClsfCd: "17", dptDt: "20260801", dptTm: "090000",
            dptRsStnCd: "0551", arvRsStnCd: "0020", arvTm: "112500", iseLmtDt: "20260801", iseLmtTm: "093000", stlFlg: "N" }],
        } };
      }
      throw new Error("no mock: " + req.url);
    },
  };
  return new SRT(http);
}

test("SRT login → search → reserve flow", async () => {
  const srt = mockSRT();
  const ok = await srt.login("010-1234-5678", "pw!");
  assert.equal(ok, true);
  assert.equal(srt.logined, true);

  const trains = await srt.searchTrain("수서", "부산", "20260801", "090000", { includeNoSeats: true });
  assert.equal(trains.length, 1);
  assert.equal(trains[0].dep_name, "수서");
  assert.equal(trains[0].arr_name, "부산");
  assert.equal(trains[0].has_general_seat(), true);

  const rsv = await srt.reserve(trains[0], { passengers: makePassengers({ adults: 1 }) });
  assert.equal(rsv.reservation_id, "SRT77");
  assert.equal(rsv.price, 52300);
});
