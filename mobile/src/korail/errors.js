// Korail error types, mirroring korail2's error classes and their h_msg_cd
// code sets so the macro loop can classify failures by type (not by string).

export class KorailError extends Error {
  constructor(msg, code) {
    super(`${msg} (${code})`);
    this.name = "KorailError";
    this.msg = msg;
    this.code = code;
  }
}
export class NeedToLoginError extends KorailError {
  constructor(code = null) {
    super("Need to Login", code);
    this.name = "NeedToLoginError";
  }
}
export class NoResultsError extends KorailError {
  constructor(code = null) {
    super("No Results", code);
    this.name = "NoResultsError";
  }
}
export class SoldOutError extends KorailError {
  constructor(code = null) {
    super("Sold out", code);
    this.name = "SoldOutError";
  }
}

const NO_RESULTS_CODES = new Set(["P100", "WRG000000", "WRD000061", "WRT300005"]);
const NEED_LOGIN_CODES = new Set(["P058"]);
const SOLD_OUT_CODES = new Set(["ERR211161"]);

// korail2._result_check: raise the mapped typed error on strResult === "FAIL".
export function resultCheck(data) {
  if (data.strResult === "FAIL") {
    const code = data.h_msg_cd;
    if (NO_RESULTS_CODES.has(code)) throw new NoResultsError(code);
    if (NEED_LOGIN_CODES.has(code)) throw new NeedToLoginError(code);
    if (SOLD_OUT_CODES.has(code)) throw new SoldOutError(code);
    throw new KorailError(data.h_msg_txt || "Korail error", code);
  }
  return true;
}
