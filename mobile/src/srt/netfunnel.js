// NetFunnel handshake for SRT — a JS port of SRT/netfunnel.py.
//
// SRT gates its search/reserve endpoints behind NetFunnel (a Korean traffic
// queue). Before each search/reserve, the app fetches a NetFunnel key and
// marks it complete; the key is then passed as `netfunnelKey`. No crypto —
// just GETs to nf.letskorail.com returning a text payload we parse.
//
// The endpoint is http:// (cleartext); the Android app whitelists that host in
// a network security config so CapacitorHttp may reach it.

const NF_URL = "http://nf.letskorail.com/ts.wseq";
const OP = { getTidchkEnter: "5101", chkEnter: "5002", setComplete: "5004" };
const STATUS_PASS = "200";
const STATUS_FAIL = "201";
const ALREADY_COMPLETED = "502";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 SRT-APP-iOS V.2.0.18",
  Accept: "*/*",
  Referer: "https://app.srail.or.kr:443",
};

const RESULT_SUBKEYS = ["key", "nwait", "nnext", "tps", "ttl", "ip", "port", "msg"];

// Parse the "NetFunnel.gRtype=...;NetFunnel.gControl.result='5002:201:key=..&nwait=..';..." text.
export function parseNetFunnel(text) {
  const data = {};
  for (const raw of String(text).split(";")) {
    const part = raw.trim();
    if (part.startsWith("NetFunnel.gRtype")) {
      data.opcode = part.slice("NetFunnel.gRtype".length + 1);
    }
    if (part.startsWith("NetFunnel.gControl.result")) {
      const inner = part.slice("NetFunnel.gControl.result".length + 1).replace(/^'|'$/g, "");
      const results = inner.split(":");
      if (results.length === 3) {
        data.next_code = results[0];
        data.status = results[1];
        for (const kv of results[2].split("&")) {
          for (const sk of RESULT_SUBKEYS) {
            if (kv.startsWith(sk)) {
              data[sk] = kv.split("=")[1];
              break;
            }
          }
        }
      }
    }
  }
  return data;
}

export class NetFunnel {
  constructor(http, { sleep } = {}) {
    this.http = http;
    this.cachedKey = null;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async _get(params) {
    let res;
    try {
      res = await this.http.request({ method: "GET", url: NF_URL, params, headers: HEADERS });
    } catch (e) {
      const err = new Error("SRT 대기열 서버(nf.letskorail.com) 연결 실패 — 네트워크/보안설정을 확인하세요.");
      err.kind = "netfunnel";
      throw err;
    }
    return parseNetFunnel(typeof res.data === "string" ? res.data : JSON.stringify(res.data));
  }

  async generateKey(useCache) {
    const key = await this._getKey(useCache);
    await this._setComplete(key);
    return key;
  }

  async _getKey(useCache) {
    if (useCache && this.cachedKey) return this.cachedKey;
    const parsed = await this._get({
      opcode: OP.getTidchkEnter,
      nfid: "0",
      prefix: `NetFunnel.gRtype=${OP.getTidchkEnter};`,
      sid: "service_1",
      aid: "act_10",
      js: "true",
      [String(Date.now())]: "",
    });
    let key = parsed.key;
    if (!key) {
      const err = new Error("SRT 대기열 키 수신 실패 — 잠시 후 다시 시도하세요.");
      err.kind = "netfunnel";
      throw err;
    }
    if (parsed.status === STATUS_FAIL) {
      key = await this._waitUntilComplete(key, parsed.nwait || "?", 0);
    }
    this.cachedKey = key;
    return key;
  }

  async _waitUntilComplete(key, nwait, depth) {
    if (depth > 30) return key; // safety cap
    const parsed = await this._get({
      opcode: OP.chkEnter,
      key,
      nfid: "0",
      prefix: `NetFunnel.gRtype=${OP.chkEnter};`,
      ttl: "1",
      sid: "service_1",
      aid: "act_10",
      js: "true",
      [String(Date.now())]: "",
    });
    const key2 = parsed.key;
    if (!key2) throw new Error("NetFunnel key not found in response");
    if (parsed.nwait && parsed.nwait !== "0") {
      await this.sleep(1000);
      return this._waitUntilComplete(key2, parsed.nwait, depth + 1);
    }
    return key2;
  }

  async _setComplete(key) {
    const parsed = await this._get({
      opcode: OP.setComplete,
      key,
      nfid: "0",
      prefix: `NetFunnel.gRtype=${OP.setComplete};`,
      js: "true",
      [String(Date.now())]: "",
    });
    // 200 (pass) or 502 (already completed) are both fine.
    if (parsed.status !== STATUS_PASS && parsed.status !== ALREADY_COMPLETED) {
      // Non-fatal: some responses omit status on complete; proceed.
    }
  }
}
