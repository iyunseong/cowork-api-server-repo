#!/usr/bin/env python3
"""Reference outputs from the SRTrain Python library so the JS SRT port can be
checked. Deterministic pieces only (parsing/building) — no network."""
import base64
import json

from SRT.train import SRTTrain
from SRT.passenger import Adult, Child, Senior
from SRT.netfunnel import NetFunnelResponse

SAMPLE_TRAIN = {
    "stlbTrnClsfCd": "17", "trnNo": "351", "dptDt": "20260801", "dptTm": "090000",
    "dptRsStnCd": "0551", "arvDt": "20260801", "arvTm": "112500", "arvRsStnCd": "0020",
    "gnrmRsvPsbStr": "예약가능", "sprmRsvPsbStr": "매진", "rsvWaitPsbCd": "0",
    "arvStnRunOrdr": "000010", "arvStnConsOrdr": "000010",
    "dptStnRunOrdr": "000001", "dptStnConsOrdr": "000001",
}

TRAIN_ID_FIELDS = [
    "train_number", "dep_date", "dep_time", "arr_date", "arr_time",
    "train_code", "dep_station_code", "arr_station_code",
    "dep_station_run_order", "arr_station_run_order",
]


def train_id(t: SRTTrain) -> str:
    obj = {
        "train_number": t.train_number, "dep_date": t.dep_date, "dep_time": t.dep_time,
        "arr_date": t.arr_date, "arr_time": t.arr_time, "train_code": t.train_code,
        "dep_station_code": t.dep_station_code, "arr_station_code": t.arr_station_code,
        "dep_station_run_order": t.dep_station_run_order,
        "arr_station_run_order": t.arr_station_run_order,
    }
    payload = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return "srt:v1:" + base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


NETFUNNEL_TEXT = (
    "NetFunnel.gRtype=5101;"
    "NetFunnel.gControl.result='5101:200:key=ABCKEY123&nwait=0&nnext=0&tps=1&ttl=1&ip=1.2.3.4&port=80';"
    "NetFunnel.gControl._showResult();"
)


if __name__ == "__main__":
    t = SRTTrain(SAMPLE_TRAIN)
    pax_dict = Adult.get_passenger_dict(
        [Adult(2), Child(1), Senior(1)], special_seat=False, window_seat=None
    )
    nf = NetFunnelResponse.parse(NETFUNNEL_TEXT)
    print(json.dumps({
        "sampleTrain": SAMPLE_TRAIN,
        "trainId": train_id(t),
        "general_seat_available": t.general_seat_available(),
        "special_seat_available": t.special_seat_available(),
        "seat_available": t.seat_available(),
        "reserve_standby_available": t.reserve_standby_available(),
        "passengerDict": pax_dict,
        "netfunnelText": NETFUNNEL_TEXT,
        "netfunnel": {"key": nf.get("key"), "status": nf.get("status"), "nwait": nf.get("nwait")},
    }, ensure_ascii=False))
