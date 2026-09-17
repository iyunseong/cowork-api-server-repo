// Terminal code seeds. Only codes that were verified in the k-skill session
// probes are listed; there is no public code table, so the app also lets the
// user type a code directly and (for KOBUS) load the route list at runtime.
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
