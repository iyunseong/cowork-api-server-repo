// Terminal code seeds. Only codes that were verified in the k-skill session
// probes are listed; there is no public code table, so the app also lets the
// user type a code directly and loads terminal lists from the sites at runtime
// (KOBUS: route-list ajax; Tmoney: tolerant scan of the terminal pages).
//
// KOBUS (고속버스) codes are 3 digits; Tmoney (시외버스) codes are 7 digits.
// They are different systems — never mix them.

export const KOBUS_TERMINALS = [
  { name: "서울경부", code: "010" },
  { name: "센트럴시티(서울)", code: "021" },
  { name: "부산", code: "700" },
  { name: "광주(유·스퀘어)", code: "500" },
  { name: "포항", code: "828" },
];

export const TMONEY_TERMINALS = [
  { name: "동서울", code: "0511601" },
  { name: "속초", code: "2482701" },
];

export function findTerminal(list, nameOrCode) {
  const q = String(nameOrCode || "").trim();
  if (!q) return null;
  return list.find((t) => t.code === q) || list.find((t) => t.name === q) || list.find((t) => t.name.includes(q)) || null;
}

// Tolerant "code ↔ Korean name" pair scanner for server pages / JSON we cannot
// inspect offline. Recognises the usual shapes:
//   <option value="0511601">동서울</option>      data-cd="0511601" ...>동서울<
//   fn('0511601','동서울')  ["0511601","동서울"]  {"trmlCd":"0511601","trmlNm":"동서울"}
//   and the reversed order ('동서울','0511601').
// Returns unique {name, code} pairs (first name wins per code).
export function scanTerminalPairs(text, digits = 7) {
  const s = String(text || "");
  const D = `\\d{${digits}}`;
  const NAME = "[가-힣][가-힣A-Za-z0-9()（）·ㆍ\\-\\s]{0,24}";
  const patterns = [
    new RegExp(`(?:value|data-[\\w-]*(?:cd|code)|data-code)=["'](${D})["'][^>]*>\\s*(${NAME})\\s*<`, "g"),
    new RegExp(`["'](${D})["']\\s*,\\s*["'](${NAME})["']`, "g"),
    new RegExp(`["'](${NAME})["']\\s*,\\s*["'](${D})["']`, "g"),
    new RegExp(`"[\\w]*(?:Cd|CD|cd|Code|code|Id|id)"\\s*:\\s*"(${D})"[^{}]{0,200}?"[\\w]*(?:Nm|NM|nm|Name|name)"\\s*:\\s*"(${NAME})"`, "g"),
    new RegExp(`"[\\w]*(?:Nm|NM|nm|Name|name)"\\s*:\\s*"(${NAME})"[^{}]{0,200}?"[\\w]*(?:Cd|CD|cd|Code|code|Id|id)"\\s*:\\s*"(${D})"`, "g"),
  ];
  const seen = new Map();
  patterns.forEach((re, i) => {
    const reversed = i === 2 || i === 4;
    for (const m of s.matchAll(re)) {
      const code = reversed ? m[2] : m[1];
      const name = (reversed ? m[1] : m[2]).replace(/\s+/g, " ").trim();
      if (!name || !/[가-힣]/.test(name)) continue;
      if (/^\d+$/.test(name)) continue;
      if (!seen.has(code)) seen.set(code, name);
    }
  });
  return [...seen.entries()].map(([code, name]) => ({ name, code }));
}

export function mergeTerminals(base, found) {
  const merged = new Map(base.map((t) => [t.code, t]));
  for (const t of found) if (!merged.has(t.code)) merged.set(t.code, t);
  return [...merged.values()];
}
