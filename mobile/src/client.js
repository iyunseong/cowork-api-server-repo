// Operator-agnostic client factory. Returns a Korail (KTX) or SRT client that
// share the same interface consumed by app.js and macro.js:
//   login(id, pw), searchTrain(dep, arr, date, time, opts), reserve(train, opts),
//   findTrainById(trains, id), buildTrainId(train), makePassengers(opts).

import { Korail } from "./korail/korail.js";
import { SRT, SRT_STATIONS } from "./srt/srt.js";

// KTX/Korail stations commonly used (for the search datalist).
export const KTX_STATIONS = [
  "서울", "용산", "광명", "천안아산", "오송", "대전", "동대구", "부산", "울산", "포항",
  "광주송정", "목포", "여수엑스포", "익산", "전주", "강릉", "남춘천", "행신", "수원", "평택",
];

export const OPERATORS = {
  ktx: { label: "KTX (코레일)", stations: KTX_STATIONS },
  srt: { label: "SRT (수서고속철)", stations: SRT_STATIONS },
};

export function createClient(operator, http) {
  return operator === "srt" ? new SRT(http) : new Korail(http);
}

export function stationsFor(operator) {
  return (OPERATORS[operator] || OPERATORS.ktx).stations;
}
