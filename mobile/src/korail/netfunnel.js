// Korail NetFunnel queue gate (nf.letskorail.com), as the 코레일+ app uses it
// before train search / reservation / reservation-list calls:
//   5101 getTidChkEnter(sid, aid) → while 201/202: wait ttl, 5002 chkEnter(key)
//   → send the API request → 5004 setComplete(key).
// The pass key is NOT attached to the API request; the queue only paces us.
// Policy: never block the user's request on queue trouble — on any transport
// or parse error we proceed without a pass (the app's own "ErrorBypass" for
// inquiry gates). Block codes 301/302 are reported as errors.

const NF_URL = "https://nf.letskorail.com/ts.wseq";
const SID = "service_1";
export const GATE_ACTIONS = { inquiry: "act_8", reserve: "act_14", reservations: "act_21" };
const UA = "Dalvik/2.1.0 (Linux; U; Android 13; SM-S928N Build/UP1A.231005.007)";
const HEADERS = { "User-Agent": UA, "Accept-Charset": "UTF-8", "Content-Type": "application/x-www-form-urlencoded" };

export function parseQueueReply(text) {
  const s = String(text || "").trim();
  const i = s.indexOf(":");
  if (i < 0) return null;
  const code = s.slice(0, i).trim();
  if (!/^-?\d+$/.test(code)) return null;
  const params = {};
  for (const item of s.slice(i + 1).split("&")) {
    const j = item.indexOf("=");
    if (j > 0) params[item.slice(0, j)] = item.slice(j + 1);
  }
  return { code, key: params.key || "", params, raw: s };
}

export class KorailQueue {
  constructor(http, { sleep, maxWaitMs = 60000 } = {}) {
    this.http = http;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxWaitMs = maxWaitMs;
    this.lastDiag = null;
  }

  async _call(params) {
    const res = await this.http.request({ method: "POST", url: NF_URL, params, data: "", headers: HEADERS });
    const parsed = parseQueueReply(typeof res.data === "string" ? res.data : JSON.stringify(res.data));
    if (!parsed) throw new Error("queue reply not understood");
    return parsed;
  }

  // Runs `send` once the queue admits us (or immediately if the queue misbehaves).
  async run(gate, send) {
    const aid = GATE_ACTIONS[gate] || GATE_ACTIONS.inquiry;
    let key = "";
    try {
      let t = await this._call({ opcode: "5101", sid: SID, aid });
      key = t.key;
      const started = Date.now();
      while (t.code === "201" || t.code === "202") {
        if (!t.key || Date.now() - started > this.maxWaitMs) break;
        const ttl = Math.max(1, Math.min(parseInt(t.params.ttl || "1", 10) || 1, 30));
        await this.sleep(ttl * 1000);
        t = await this._call({ opcode: "5002", key: t.key });
        key = t.key || key;
      }
      if (t.code === "301" || t.code === "302") {
        const e = new Error("코레일 대기열에서 요청이 차단되었습니다(" + t.code + "). 잠시 후 다시 시도하세요.");
        e.kind = "netfunnel";
        throw e;
      }
      this.lastDiag = `queue ${gate}: ${t.code}`;
    } catch (e) {
      if (e && e.kind === "netfunnel") throw e;
      this.lastDiag = `queue ${gate}: bypass (${e && e.message})`;
    }
    try {
      return await send();
    } finally {
      if (key) { try { await this._call({ opcode: "5004", key }); } catch (_) { /* best effort */ } }
    }
  }
}
