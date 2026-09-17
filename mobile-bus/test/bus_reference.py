#!/usr/bin/env python3
"""Reference outputs from the vendored k-skill bus helpers (pure parsing
functions only — no network) so the JS port can be checked on synthetic HTML
that mirrors the documented page structure."""
import json
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "vendor"))

import kobus_express_booking as kb  # noqa: E402
import intercity_bus_search as ic  # noqa: E402

KOBUS_SEARCH_HTML = """
<html><body>
<form id="alcnSrchFrm" name="alcnSrchFrm">
<input type="hidden" name="deprCd" value="010"><input type="hidden" name="arvlCd" value="700">
<input type="hidden" name="deprDtm" value="20260509"><input type="hidden" name="deprTime" value="">
<input type="hidden" name="alcnDeprTime" value=""><input type="hidden" name="alcnDeprTrmlNo" value="">
<input type="hidden" name="alcnArvlTrmlNo" value=""><input type="hidden" name="indVBusClsCd" value="">
<input type="hidden" name="cacmCd" value=""><input type="hidden" name="dcDvsCd" value="">
<input type="hidden" name="prvtBbizEmpAcmtRt" value=""><input type="hidden" name="chldSftySatsYn" value="">
<input type="hidden" name="dsprSatsYn" value=""><input type="hidden" name="busClsCd" value="0">
</form>
<ul>
<li class="alcn"><span class="time">00:30</span> <span class="cacm">천일고속</span> <span class="cls">심야우등</span> <span class="seat">잔여 10석</span>
 <a href="#" onclick="fnSatsChc('20260509','003000','003000','010','700','3','07','0','Y','N','010','700','N','N','N','N')">좌석선택</a></li>
<li class="alcn"><span class="time">07:00</span> <span class="cacm">동양고속</span> <span class="cls">우등</span> <span class="seat">잔여 0석</span>
 <a href="#" onclick="fnSatsChc('20260509','070000','070000','010','700','3','02','0','Y','N','010','700','N','N','N','N')">좌석선택</a></li>
</ul></body></html>
"""

KOBUS_SEAT_HTML = """
<html><body><form id="satsChcFrm">
<input type="hidden" name="deprTime" value="003000"><input type="hidden" name="alcnDeprTrmlNo" value="010">
<input type="hidden" name="alcnArvlTrmlNo" value="700"><input type="hidden" name="adltFee" value="47600">
<input type="hidden" name="rmnSatsNum" value="10"><input type="hidden" name="totSatsNum" value="28">
<input type="hidden" name="selSeatNum" value=""><input type="hidden" name="selSeatCnt" value="">
<input type="hidden" name="selAdltCnt" value=""><input type="hidden" name="selAdltDcCnt" value="">
<input type="hidden" name="prmmDcDvsCd" value="0"><input type="hidden" name="nonMbrsYn" value="">
<input type="hidden" name="satsNoAll" value=""><input type="hidden" name="pcpyNoAll" value="">
<div class="seats">
<input type="checkbox" name="seatBoxDtl" value="01" disabled="disabled">
<input type="checkbox" name="seatBoxDtl" value="02">
<input type="checkbox" name="seatBoxDtl" value="03">
</div></form></body></html>
"""

TMONEY_TT_HTML = """
<table><tbody>
<tr><td><div class="td_wrap1">06:05</div></td><td><div class="td_wrap1">금강고속 2시간10분</div></td>
<td><div class="td_wrap1">우등</div></td><td><div class="td_wrap1">21,300원</div></td>
<td><div class="td_wrap1">10,700원</div></td><td><div class="td_wrap1">17,000원</div></td>
<td><button onclick="readSasFeeInf('RT201603150047276','1','20260509','1','0511601','2482701','동서울','속초','060500','C004','IDP','금강고속','우등','1','0','0','8','28','20260509','060500','Y')">예매</button></td></tr>
<tr><td><div class="td_wrap1">08:00</div></td><td><div class="td_wrap1">금강고속 2시간10분</div></td>
<td><div class="td_wrap1">우등</div></td><td><div class="td_wrap1">21,300원</div></td>
<td><div class="td_wrap1">10,700원</div></td><td><div class="td_wrap1">17,000원</div></td>
<td><button onclick="readSasFeeInf('RT201603150047276','2','20260509','2','0511601','2482701','동서울','속초','080000','C004','IDP','금강고속','우등','1','0','0','0','28','20260509','080000','Y')">예매</button></td></tr>
</tbody></table>
"""

TMONEY_SEAT_HTML = """
<form id="readPcpySats">
<input type="hidden" name="rot_Id" value="RT201603150047276"><input type="hidden" name="alcn_Sqno" value="1">
<input type="hidden" name="depr_Trml_Cd" value="0511601"><input type="hidden" name="arvl_Trml_Cd" value="2482701">
<input type="hidden" name="depr_Time" value="060500"><input type="hidden" name="igFee" value="21300">
<input type="hidden" name="total" value="21300"><input type="hidden" name="ig_Knd_Cd" value="IG00">
</form>
<ul class="seat"><li class="on"><a href="#"><span>1</span></a></li><li class="disabled"><a href="#"><span>2</span></a></li><li><a href="#"><span>3</span></a></li></ul>
"""


def kobus_schedules(body: str):
    out = []
    for idx, m in enumerate(kb.FN_SATS_RE.finditer(body), 1):
        args = kb.ARG_RE.findall(m.group(1))
        context = kb.strip_tags(body[max(0, m.start() - 900): m.start() + 900])
        out.append({
            "index": idx,
            "args": args,
            "company": (re.search(r"\((?:주|유)\)[^\s]+|[가-힣]+고속", context) or [None])[0],
            "bus_class": (re.search(r"심야우등|우등|프리미엄|고속", context) or [None])[0],
            "remaining_text": (re.search(r"잔여\s*\d+석|\d+\s*/\s*\d+", context) or [None])[0],
        })
    return out


def main():
    ks = kobus_schedules(KOBUS_SEARCH_HTML)
    search_form = kb.parse_form(KOBUS_SEARCH_HTML, "alcnSrchFrm")
    sched = kb.Schedule(index=1, departure_time=None, company=None, bus_class=None, remaining_text=None, raw_args=ks[0]["args"])
    kobus = {
        "searchHtml": KOBUS_SEARCH_HTML,
        "seatHtml": KOBUS_SEAT_HTML,
        "schedules": ks,
        "searchForm": search_form,
        "seatStageFields": kb.seat_stage_fields(search_form, sched),
        "satsForm": kb.parse_form(KOBUS_SEAT_HTML, "satsChcFrm"),
        "seats": [kb.attrs(t)["value"] for t in kb.SEAT_RE.findall(KOBUS_SEAT_HTML) if "disabled" not in t and kb.attrs(t).get("value")],
    }

    ts = ic.parse_schedules(TMONEY_TT_HTML)
    s0 = ts[0]
    tmoney = {
        "ttHtml": TMONEY_TT_HTML,
        "seatHtml": TMONEY_SEAT_HTML,
        "schedules": [ic.asdict(s) for s in ts],
        "seatStageFields": ic._seat_stage_fields(s0, "000000"),
        "form": ic._form_fields(TMONEY_SEAT_HTML, "readPcpySats"),
        "seats": ic._available_seats(TMONEY_SEAT_HTML),
    }
    print(json.dumps({"kobus": kobus, "tmoney": tmoney}, ensure_ascii=False))


if __name__ == "__main__":
    main()
