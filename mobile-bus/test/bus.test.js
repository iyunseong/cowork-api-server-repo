// JS bus parsers vs the vendored Python helpers (oracle) on synthetic HTML
// mirroring the documented KOBUS/Tmoney page structures, plus mocked
// search → reserve flows producing the checkout forms.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseForm } from "../src/bus/http-html.js";
import * as K from "../src/bus/kobus.js";
import * as T from "../src/bus/tmoney.js";

const here = dirname(fileURLToPath(import.meta.url));
const ref = JSON.parse(execFileSync("python3", [join(here, "bus_reference.py")], { encoding: "utf-8" }));

// ---------- KOBUS ----------
test("KOBUS: schedule args/company/class/remaining match Python", () => {
  const js = K.parseSchedules(ref.kobus.searchHtml);
  assert.equal(js.length, ref.kobus.schedules.length);
  js.forEach((s, i) => {
    const py = ref.kobus.schedules[i];
    assert.deepEqual(s.raw_args, py.args);
    assert.equal(s.company, py.company);
    assert.equal(s.bus_class, py.bus_class);
    assert.equal(s.remaining_text, py.remaining_text); // helper heuristic parity
  });
  // Nearest-match seat count is row-accurate even for adjacent rows.
  assert.equal(js[0].remaining, 10);
  assert.equal(js[1].remaining, 0);
});

test("KOBUS: alcnSrchFrm + seat-stage fields + satsChcFrm + seats match Python", () => {
  const form = parseForm(ref.kobus.searchHtml, "alcnSrchFrm");
  assert.deepEqual(form, ref.kobus.searchForm);
  const stage = K.seatStageFields(form, ref.kobus.schedules[0].args);
  assert.deepEqual(stage, ref.kobus.seatStageFields);
  assert.deepEqual(parseForm(ref.kobus.seatHtml, "satsChcFrm"), ref.kobus.satsForm);
});

test("KOBUS: mocked search → hold produces checkout form with hold ids", async () => {
  const calls = [];
  const http = {
    async request(req) {
      calls.push(req);
      if (req.url.endsWith("/main.do")) return { status: 200, data: "<html>ok</html>" };
      if (req.url.includes("alcnSrch.do")) return { status: 200, data: ref.kobus.searchHtml };
      if (req.url.includes("satschc.do")) {
        assert.equal(req.data.deprTime, "003000"); // seat stage carries fnSatsChc args
        assert.equal(req.data.cacmCd, "07");
        return { status: 200, data: ref.kobus.seatHtml };
      }
      if (req.url.includes("setPcpy.ajax")) {
        assert.equal(req.data.selSeatNum, "02"); // first non-disabled seat
        assert.equal(req.data.selAdltCnt, "1");
        return { status: 200, data: { MSG_CD: "S0000", pcpyNoAll: "PC123", satsNoAll: "02", ESTM_AMT: "47600", DC_AMT: "0", TISSU_AMT: "47600" } };
      }
      throw new Error("no mock " + req.url);
    },
  };
  const c = new K.Kobus(http);
  const all = await c.searchTrain("서울경부", "부산", "20260509", "000000", { includeNoSeats: true });
  assert.equal(all.length, 2);
  assert.equal(all[0].has_seat(), true);
  assert.equal(all[1].has_seat(), false); // 잔여 0석
  const open = await c.searchTrain("010", "700", "20260509", "000000");
  assert.equal(open.length, 1);
  const rsv = await c.reserve(open[0]);
  assert.equal(rsv.reservation_id, "PC123");
  assert.equal(rsv.seat, "02");
  assert.equal(rsv.price, 47600);
  assert.ok(rsv.checkout.action.endsWith("/mrs/stplcfmpym.do?keep=/mrs/pay"));
  const co = Object.fromEntries(rsv.checkout.fields);
  assert.equal(co.pcpyNoAll, "PC123");
  assert.equal(co.nonMbrsYn, "Y");
  assert.equal(co.tissuAmt, "47600");
  // sold-out target keeps polling: tolerant findTrainById returns a no-seat placeholder
  const id = c.buildTrainId(all[1]);
  assert.equal(c.findTrainById(open, id).has_seat(), false);
});

// ---------- Tmoney ----------
test("Tmoney: parse_schedules matches Python", () => {
  const js = T.parseSchedules(ref.tmoney.ttHtml);
  assert.equal(js.length, ref.tmoney.schedules.length);
  js.forEach((s, i) => {
    const py = ref.tmoney.schedules[i];
    assert.deepEqual(s.raw_args, py.raw_args);
    assert.equal(s.departure_time, py.departure_time);
    assert.equal(s.company, py.company);
    assert.equal(s.duration, py.duration);
    assert.equal(s.bus_class, py.bus_class);
    assert.equal(s.adult_fare, py.adult_fare);
    assert.equal(s.remaining_seats, py.remaining_seats);
    assert.equal(s.total_seats, py.total_seats);
  });
});

test("Tmoney: seat-stage fields, readPcpySats form and available seats match Python", () => {
  const s0 = T.parseSchedules(ref.tmoney.ttHtml)[0];
  assert.deepEqual(T.seatStageFields(s0.raw_args, "000000"), ref.tmoney.seatStageFields);
  assert.deepEqual(parseForm(ref.tmoney.seatHtml, "readPcpySats"), ref.tmoney.form);
  assert.deepEqual(T.availableSeats(ref.tmoney.seatHtml), ref.tmoney.seats);
});

test("Tmoney: mocked search → reserve prepares the WebView hold form", async () => {
  const http = {
    async request(req) {
      if (req.url.includes("trmlInfEnty")) return { status: 200, data: "<html/>" };
      if (req.url.includes("readAlcnList")) {
        assert.equal(req.data.bef_Aft_Dvs, "D"); // required hidden fields
        assert.equal(req.data.req_Rec_Num, "10");
        assert.equal(req.data.depr_Trml_Nm, "동서울");
        return { status: 200, data: ref.tmoney.ttHtml };
      }
      if (req.url.includes("readSatsFee")) {
        assert.equal(req.data.rot_Id, "RT201603150047276");
        return { status: 200, data: ref.tmoney.seatHtml };
      }
      throw new Error("no mock " + req.url);
    },
  };
  const c = new T.Tmoney(http);
  const all = await c.searchTrain("동서울", "속초", "20260509", "000000", { includeNoSeats: true });
  assert.equal(all.length, 2);
  assert.equal(all[0].has_seat(), true);
  assert.equal(all[1].has_seat(), false);
  const rsv = await c.reserve(all[0]);
  assert.equal(rsv.pending, true);
  assert.equal(rsv.seat, "1"); // first non-disabled <li>
  const f = Object.fromEntries(rsv.checkout.fields);
  assert.equal(f.sats_No, "1");
  assert.equal(f.bus_Tck_Knd_Cd, "IG00");
  assert.equal(f.cty_Bus_Dc_Knd_Cd, "Z");
  assert.ok(rsv.checkout.action.endsWith("/otck/readPcpySats.do"));
});
