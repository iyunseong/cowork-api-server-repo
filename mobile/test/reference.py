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


def token():
    engine = DynaPathMasterEngine()
    engine.app_start_ts = APP_START_TS
    return engine.generate_token(DEVICE_ID, TIMESTAMP_MS, NONCE)


def sid():
    cipher = AES.new(SID_KEY, AES.MODE_CBC, iv=SID_KEY)
    plaintext = f"{DEVICE}{TIMESTAMP_MS}".encode("utf-8")
    return base64.b64encode(cipher.encrypt(pad(plaintext, 16))).decode("utf-8") + "\n"


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
        "token": token(),
        "sid": sid(),
        "encPassword": enc_password(),
    }))
