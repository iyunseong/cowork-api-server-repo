#!/usr/bin/env python3
"""Emit reference crypto/token outputs from the Python implementation so the
JS port can be checked byte-for-byte. Uses the vendored DynaPathMasterEngine
(the real code path) and pycryptodome for the AES pieces."""
import base64
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "ktx"))

from Crypto.Cipher import AES  # noqa: E402
from Crypto.Util.Padding import pad  # noqa: E402
from ktx_booking import DynaPathMasterEngine, build_train_id  # noqa: E402
from korail2.korail2 import Train  # noqa: E402

# Fixed inputs so Python and JS compute over identical data.
APP_START_TS = "1700000000000"
DEVICE_ID = "558a4f02041657ea"
TIMESTAMP_MS = 1735689600000
NONCE = "AB12"
SID_KEY = b"2485dd54d9deaa36"
DEVICE = "AD"
PASSWORD = "hunter2!pw"
LOGIN_KEY = "0123456789abcdef"  # 16-char key as returned by KORAIL_CODE


# Oracle for the 코레일+ 7.0.8 protocol: korail-mobile-api (Apache-2.0).
from korail_mobile_api.dynapath import DynapathTokenSettings, generate_dynapath_token, KORAIL_DYNAPATH_AS_VALUE  # noqa: E402
from korail_mobile_api.crypto import transform_login_password  # noqa: E402
from korail_mobile_api.models import LoginCryptoInfo, TrainSearchQuery, TrainSummary  # noqa: E402
from korail_mobile_api.config import KorailConfig  # noqa: E402
from korail_mobile_api.payloads import build_train_search_form, build_common_code_form  # noqa: E402
from korail_mobile_api.mutation_payloads import build_reservation_form  # noqa: E402

RT_INTERVALS = [600000, 1500, 7000]


def token():
    # SDK v1.0.3 token with an interval history (what the 7.0.8 app sends).
    settings = DynapathTokenSettings(
        device_id=DEVICE_ID, as_value=KORAIL_DYNAPATH_AS_VALUE, app_start_ts=str(APP_START_TS),
        os_version="13", device_model="SM-S928N",
    )
    return generate_dynapath_token(settings, timestamp_ms=TIMESTAMP_MS, random_text=NONCE, recent_intervals=tuple(RT_INTERVALS))


def token_legacy():
    engine = DynaPathMasterEngine()
    engine.app_start_ts = APP_START_TS
    return engine.generate_token(DEVICE_ID, TIMESTAMP_MS, NONCE)


def sid():
    cipher = AES.new(SID_KEY, AES.MODE_CBC, iv=SID_KEY)
    plaintext = f"{DEVICE}{TIMESTAMP_MS}".encode("utf-8")
    return base64.b64encode(cipher.encrypt(pad(plaintext, 16))).decode("utf-8") + "\n"


def enc_password_app():
    # App-style: inner standard base64, outer URL-safe base64 wrapped at 76 cols + "\n".
    return transform_login_password(PASSWORD, LoginCryptoInfo(idx="77", key=LOGIN_KEY, pwd_aes_cphd=""))


def enc_password():
    encrypt_key = LOGIN_KEY.encode("utf-8")
    iv = LOGIN_KEY[:16].encode("utf-8")
    cipher = AES.new(encrypt_key, AES.MODE_CBC, iv)
    padded = pad(PASSWORD.encode("utf-8"), AES.block_size)
    return base64.b64encode(base64.b64encode(cipher.encrypt(padded))).decode("utf-8")


SAMPLE_TRAIN = {
    "h_trn_clsf_cd": "00", "h_trn_clsf_nm": "KTX", "h_trn_gp_cd": "300",
    "h_trn_no": "101", "h_dpt_rs_stn_nm": "서울", "h_dpt_rs_stn_cd": "0001",
    "h_dpt_dt": "20260801", "h_dpt_tm": "090000", "h_arv_rs_stn_nm": "부산",
    "h_arv_rs_stn_cd": "0020", "h_arv_dt": "20260801", "h_arv_tm": "115300",
    "h_run_dt": "20260801", "h_rsv_psb_flg": "Y", "h_spe_rsv_cd": "00",
    "h_gen_rsv_cd": "11", "h_wait_rsv_flg": "0",
}


def train_id():
    return build_train_id(Train(SAMPLE_TRAIN))


SAMPLE_TRAIN_FULL = dict(SAMPLE_TRAIN, h_dpt_stn_cons_ordr="000001", h_dpt_stn_run_ordr="000001",
                         h_arv_stn_cons_ordr="000013", h_arv_stn_run_ordr="000010")


def forms():
    cfg = KorailConfig()
    q = TrainSearchQuery("서울", "부산", "20260801", "090000", passengers=2, child_passengers=1,
                         senior_passengers=1, train_group_code="109", include_srt=True)
    return {
        "search": build_train_search_form(cfg, q, departure_name="서울", arrival_name="부산", member_card_no="1234567890"),
        "searchNoMember": build_train_search_form(cfg, TrainSearchQuery("서울", "부산", "20260801", "090000", train_group_code="100"),
                                                  departure_name="서울", arrival_name="부산"),
        "reserve": build_reservation_form(cfg, TrainSummary.from_raw(SAMPLE_TRAIN_FULL)),
        "commonCode": build_common_code_form(cfg, ["app.login.cphd", "app.var.data"]),
    }


if __name__ == "__main__":
    print(json.dumps({
        "sampleTrain": SAMPLE_TRAIN,
        "trainId": train_id(),
        "inputs": {
            "appStartTs": APP_START_TS,
            "deviceId": DEVICE_ID,
            "timestampMs": TIMESTAMP_MS,
            "nonce": NONCE,
            "sidKey": SID_KEY.decode(),
            "device": DEVICE,
            "password": PASSWORD,
            "loginKey": LOGIN_KEY,
        },
        "rtIntervals": RT_INTERVALS,
        "token": token(),
        "tokenLegacy": token_legacy(),
        "sid": sid(),
        "encPassword": enc_password(),
        "encPasswordApp": enc_password_app(),
        "sampleTrainFull": SAMPLE_TRAIN_FULL,
        "forms": forms(),
    }))
