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

test("KOBUS: sold-out departure without a button is listed and targetable by time", async () => {
  const html = ref.kobus.searchHtml.replace("</ul>", '<li class="alcn"><span class="time">13:00</span> <span class="cacm">중앙고속</span> <span class="cls">우등</span> <span class="seat">매진</span></li></ul>');
  const http = { async request(req) {
    if (req.url.endsWith("/main.do")) return { status: 200, data: "<html/>" };
    if (req.url.includes("alcnSrch.do")) return { status: 200, data: html };
    throw new Error("no mock " + req.url);
  } };
  const c = new K.Kobus(http);
  const all = await c.searchTrain("010", "700", "20260509", "000000", { includeNoSeats: true });
  const so = all.find((t) => t.dep_time === "130000");
  assert.ok(so && so.placeholder, "13:00 sold-out row should appear as a placeholder");
  assert.equal(so.has_seat(), false);
  const id = await c.targetId("010", "700", "20260509", "130000");
  assert.equal(c.findTrainById(all, id), so); // manual time target matches the listed sold-out row
  assert.equal(c.findTrainById(all, await c.targetId("010", "700", "20260509", "235900")).has_seat(), false); // unlisted → still waits
});

// ---------- time window / terminal discovery ----------
import { scanTerminalPairs, findTerminal } from "../src/bus/terminals.js";

test("time window: timeMax keeps only departures inside [time, timeMax]", async () => {
  const html = ref.kobus.searchHtml.replace("</ul>", '<li class="alcn"><span class="time">13:00</span> 매진</li><li class="alcn"><span class="time">18:30</span> 매진</li></ul>');
  const http = { async request(req) {
    if (req.url.endsWith("/main.do")) return { status: 200, data: "<html/>" };
    if (req.url.includes("alcnSrch.do")) return { status: 200, data: html };
    throw new Error("no mock " + req.url);
  } };
  const c = new K.Kobus(http);
  const all = await c.searchTrain("010", "700", "20260509", "000000", { includeNoSeats: true });
  assert.deepEqual(all.map((t) => t.dep_time), ["003000", "070000", "130000", "183000"]);
  const win = await c.searchTrain("010", "700", "20260509", "070000", { includeNoSeats: true, timeMax: "130059" });
  assert.deepEqual(win.map((t) => t.dep_time), ["070000", "130000"]);
  const t = new T.Tmoney({ async request(req) {
    if (req.url.includes("trmlInfEnty")) return { status: 200, data: "<html/>" };
    if (req.url.includes("readAlcnList")) return { status: 200, data: ref.tmoney.ttHtml };
    throw new Error("no mock " + req.url);
  } });
  const tAll = await t.searchTrain("0511601", "2482701", "20260509", "000000", { includeNoSeats: true });
  assert.ok(tAll.length >= 2);
  const first = tAll[0].dep_time;
  const tWin = await t.searchTrain("0511601", "2482701", "20260509", "000000", { includeNoSeats: true, timeMax: first });
  assert.deepEqual(tWin.map((x) => x.dep_time), [first]);
});

test("terminal scanner recognises option / JS-args / JSON shapes", () => {
  const html = `
    <select><option value="0511601">동서울</option><option value="2482701">속초</option></select>
    <a onclick="fnSelTrml('3001101','부산')">부산</a>
    <li data-trml-cd="3001201" class="x">서부산(사상)</li>
    var list = [{"trmlCd":"1801101","trmlNm":"목포"},{"trml_Nm":"광주(유스퀘어)","trml_Cd":"2000101"}];
    other('부산', '3001101') stray 1234567 number`;
  const pairs = scanTerminalPairs(html, 7);
  const byCode = Object.fromEntries(pairs.map((p) => [p.code, p.name]));
  assert.deepEqual(byCode, {
    "0511601": "동서울", "2482701": "속초", "3001101": "부산", "3001201": "서부산(사상)",
    "1801101": "목포", "2000101": "광주(유스퀘어)",
  });
  assert.equal(findTerminal(pairs, "서부산").code, "3001201");
});

test("Tmoney: unknown terminal name triggers a runtime directory scan, then search proceeds", async () => {
  const urls = [];
  const http = { async request(req) {
    urls.push(req.url);
    if (req.url.includes("trmlInfEnty")) return { status: 200, data: '<option value="0511601">동서울</option><option value="3001101">부산</option>' };
    if (req.url.includes("readAlcnList")) {
      assert.equal(req.data.arvl_Trml_Cd, "3001101");
      assert.equal(req.data.arvl_Trml_Nm, "부산");
      return { status: 200, data: ref.tmoney.ttHtml };
    }
    if (req.url.includes("/main.do") || /Trml/.test(req.url)) return { status: 404, data: "<html>not found</html>" };
    throw new Error("no mock " + req.url);
  } };
  const c = new T.Tmoney(http);
  const rows = await c.searchTrain("동서울", "부산", "20260509", "000000", { includeNoSeats: true });
  assert.ok(rows.length >= 1);
  assert.ok(c.lastResolveDiag.length >= 4);
  await assert.rejects(() => c.searchTrain("동서울", "없는터미널", "20260509"), /찾을 수 없습니다/);
  assert.equal(findTerminal(c.terminals, "부산").code, "3001101"); // learned from the page scan
  assert.equal(urls.filter((u) => u.includes("trmlInfEnty")).length, 2); // session GET + one directory scan (not repeated)
});

import { scanEndpointHints, pageExcerpt, TMONEY_TERMINALS } from "../src/bus/terminals.js";

test("terminal helpers: loose name match, endpoint hints, page excerpt", () => {
  assert.equal(findTerminal(TMONEY_TERMINALS, "광주 유스퀘어").code, "6193701");
  assert.equal(findTerminal(TMONEY_TERMINALS, "인천공항2").code, "2238202");
  const page = `<script src="/js/otck/trml.js?v=3"></script><script src="https://cdn.example.com/x.js"></script>
    $.post('/otck/readTrmlSrchList.do', {trml_Nm: q}); url: "/otck/readAlcnList.do"`;
  const h = scanEndpointHints(page);
  assert.deepEqual(h.urls, ["/otck/readTrmlSrchList.do"]);
  assert.deepEqual(h.scripts, ["/js/otck/trml.js", "https://cdn.example.com/x.js"]);
  const ex = pageExcerpt("<html><title>x</title><script>var a=1;</script><body><div>안내</div><p>조회된 운행 정보가 없습니다. 다시 확인해 주세요.</p></body></html>");
  assert.match(ex, /운행 정보가 없습니다/);
});

test("Tmoney: discovered endpoints from page/scripts are queried for terminals", async () => {
  const urls = [];
  const http = { async request(req) {
    urls.push(req.method + " " + req.url);
    if (req.url.includes("trmlInfEnty")) return { status: 200, data: '<script src="/js/trml.js"></script>' };
    if (req.url.endsWith("/js/trml.js")) return { status: 200, data: "fn(){ $.post('/otck/readTrmlSrchList.do', p) }" };
    if (req.url.includes("readTrmlSrchList")) {
      assert.equal(req.data.trml_Nm, "목포");
      return { status: 200, data: { list: [{ trmlCd: "6112101", trmlNm: "목포" }] } };
    }
    return { status: 404, data: "<html>nf</html>" };
  } };
  const c = new T.Tmoney(http);
  const list = await c.resolveTerminals("목포");
  assert.equal(findTerminal(list, "목포").code, "6112101");
  assert.ok(urls.includes("GET https://intercitybus.tmoney.co.kr/js/trml.js"));
  assert.ok(urls.includes("POST https://intercitybus.tmoney.co.kr/otck/readTrmlSrchList.do"));
  assert.ok(c.lastResolveDiag.some((d) => d.includes("발견한 엔드포인트")));
});
