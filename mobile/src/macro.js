// Retry-until-reserved macro loop. Operator-agnostic: it drives any client
// (Korail/KTX or SRT) that exposes searchTrain / reserve / findTrainById and
// throws errors carrying a `kind` ('auth' | 'soldout' | 'noresults' | ...).
//
// Pure and injectable (client, sleep, shouldStop, onUpdate) so it can be
// unit-tested in Node. Assumes the client is already logged in.

export async function runMacro(job, hooks) {
  const {
    client, dep, arr, date, time,
    trainType = "100", trainId = null, passengers,
    seatOption = "general-first", tryWaiting = false,
    intervalMs = 15000, deadlineMs = null, maxAttempts = null,
    now = () => Date.now(),
  } = job;
  const { onUpdate = () => {}, shouldStop = () => false, sleep } = hooks;

  const wantSpecial = seatOption.startsWith("special");
  const mode = trainId ? "train" : "auto";
  let attempts = 0;

  const finish = (status, message, reservation = null) => {
    const result = { status, message, reservation, attempts };
    onUpdate(result);
    return result;
  };

  while (!shouldStop()) {
    if (deadlineMs && now() > deadlineMs) return finish("failed", "마감 시간을 초과했습니다.");
    if (maxAttempts && attempts >= maxAttempts) return finish("failed", `최대 시도 횟수(${maxAttempts}회)에 도달했습니다.`);

    attempts += 1;
    let target = null;

    try {
      if (mode === "auto") {
        const trains = await client.searchTrain(dep, arr, date, time, {
          trainType, passengers, includeWaitingList: tryWaiting,
        });
        target = trains.find((t) => (wantSpecial ? t.has_special_seat() || t.has_general_seat() : t.has_general_seat() || t.has_special_seat()));
        if (!target) {
          onUpdate({ status: "running", attempts, message: `빈 좌석 대기 중… (조회 ${trains.length}편)` });
          await sleep(intervalMs);
          continue;
        }
        onUpdate({ status: "running", attempts, message: `빈 좌석 발견: ${target.dep_time.slice(0, 4)} 예약 시도…` });
      } else {
        const trains = await client.searchTrain(dep, arr, date, time, {
          trainType, passengers, includeNoSeats: true, includeWaitingList: tryWaiting,
        });
        target = client.findTrainById(trains, trainId);
        if (!target) return finish("failed", "선택한 열차가 더 이상 조회되지 않습니다(운행 종료/시간표 변경).");
        const reservable = target.has_seat() || (tryWaiting && target.has_general_waiting_list());
        if (!reservable) {
          onUpdate({ status: "running", attempts, message: "좌석이 없어 재시도 중…" });
          await sleep(intervalMs);
          continue;
        }
      }

      const reservation = await client.reserve(target, { passengers, seatOption, tryWaiting });
      return finish("reserved", "예약에 성공했습니다. 코레일/SRT 앱에서 결제해 주세요.", reservation);
    } catch (e) {
      const kind = e && e.kind;
      if (kind === "auth") return finish("failed", "로그인이 만료되었습니다. 다시 로그인해 주세요.");
      if (kind === "soldout" || kind === "noresults") {
        onUpdate({ status: "running", attempts, message: "좌석이 없어 재시도 중…" });
      } else {
        onUpdate({ status: "running", attempts, message: `일시 오류, 재시도 중… (${(e && e.message) || e})` });
      }
      await sleep(intervalMs);
    }
  }

  return finish("stopped", "매크로를 중지했습니다.");
}
