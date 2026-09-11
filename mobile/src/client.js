// Operator-agnostic client factory. Returns a Korail (KTX) or SRT client that
// share the same interface consumed by app.js and macro.js:
//   login(id, pw), searchTrain(dep, arr, date, time, opts), reserve(train, opts),
//   findTrainById(trains, id), buildTrainId(train), makePassengers(opts).

import { Korail } from "./korail/korail.js";
import { SRT, SRT_STATIONS } from "./srt/srt.js";

// KTX/Korail stations commonly used (for the search datalist).
// Since the 2026 코레일+ integration, SRT trains are booked through the Korail
// (코레일 통합) account, so the KTX station list also includes SRT-only stations
// (수서/동탄/평택지제 …). Search with train type "전체" to surface SRT trains.
export const KTX_STATIONS = [
  // SRT-only origins first for visibility
  "수서", "동탄", "평택지제",
  // shared / KTX mainline
  "서울", "용산", "광명", "천안아산", "오송", "대전", "김천(구미)", "동대구", "서대구",
  "밀양", "구포", "부산", "울산(통도사)", "포항", "경주", "신경주",
  "광주송정", "정읍", "익산", "전주", "남원", "곡성", "구례구", "순천", "여천", "여수EXPO", "여수엑스포",
  "나주", "목포", "마산", "창원", "창원중앙", "진영", "진주", "공주", "강릉", "남춘천", "행신", "수원", "평택",
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
