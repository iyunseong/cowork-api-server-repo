# KTX 자동 예매 (모바일 웹앱)

핸드폰 브라우저에서 코레일 로그인 → 조건 선택 → **백그라운드 매크로**로 빈자리를
자동으로 잡고, **예약이 완료되면 알람**(알림·진동·소리)으로 알려줍니다.
결제는 자동화하지 않으며, 예약 성공 후 코레일 앱/홈페이지에서 직접 결제합니다.

이 기능은 [NomaDamas/k-skill](https://github.com/NomaDamas/k-skill) 의 `ktx-booking`
스킬(코레일 anti-bot 우회 패치 포함)을 그대로 가져와(`ktx/ktx_booking.py`, MIT)
그 위에 Node/Express 서버와 모바일 UI를 얹은 것입니다.

## 구성

```
ktx/
  ktx_booking.py   # 코레일 조회/예약 헬퍼 (k-skill에서 vendoring, MIT)
  service.js       # 헬퍼를 자식 프로세스로 실행하는 Node 래퍼
  macro.js         # 백그라운드 예매 매크로(재시도 루프) 작업 관리자
  router.js        # /ktx 정적 페이지 + /api/ktx/* API
  public/          # 모바일 PWA (index.html, app.js, styles.css, sw.js, manifest)
requirements.txt   # Python 의존성 (korail2-ncard, pycryptodome, requests)
```

## 설치 & 실행

```bash
# 1) Node 의존성
npm install

# 2) Python 3.10+ 및 코레일 헬퍼 의존성
python3 -m pip install -r requirements.txt

# 3) 서버 실행
node app.js         # http://localhost:3000
```

- 모바일 웹앱: **`http://<서버주소>:3000/ktx/`**
- 핸드폰 Chrome/Safari에서 열고 **홈 화면에 추가**하면 앱처럼 실행됩니다(PWA).
- 알림·진동은 보안 컨텍스트에서만 동작합니다. 외부에서 접속한다면 **HTTPS**로
  서비스하세요(예: 리버스 프록시). `localhost`는 예외적으로 HTTP도 허용됩니다.

Python 실행 파일 경로가 다르면 `KTX_PYTHON` 환경변수로 지정할 수 있습니다.

## 사용 흐름

1. 코레일 아이디/비밀번호 입력 (저장하지 않음, 이 요청에만 사용)
2. 출발/도착역, 날짜, 시각, 인원, 좌석 옵션 선택
3. **열차 조회** → 결과에서 **이 열차 매크로** 로 특정 열차 지정, 또는
   **가장 빠른 빈자리 자동 예매** 로 조건에 맞는 첫 빈자리를 자동 선택
4. 매크로가 서버에서 백그라운드로 돌며 주기적으로 예약을 시도
5. 예약 성공 시 알람(브라우저 알림 + 진동 + 소리 + 화면 배너)

앱을 닫았다 다시 열어도 실행 중인 작업에 자동 재연결됩니다(작업 ID를
localStorage에 저장). 진행 상황은 서버에서 계속 유지됩니다.

## API

| Method | Path | 설명 |
| --- | --- | --- |
| `GET`  | `/api/ktx/health` | Python/헬퍼 사용 가능 여부 |
| `POST` | `/api/ktx/search` | 열차 1회 조회 |
| `POST` | `/api/ktx/macro` | 백그라운드 예매 매크로 시작 (`jobId` 반환) |
| `GET`  | `/api/ktx/macro/:id` | 작업 상태 폴링 |
| `POST` | `/api/ktx/macro/:id/stop` | 작업 중지 |

`search`/`macro` 요청 본문 예시:

```json
{
  "id": "010-1234-5678",
  "password": "••••••",
  "dep": "서울", "arr": "부산",
  "date": "20260801", "time": "0900",
  "trainType": "ktx", "seatOption": "general-first",
  "adults": 1, "tryWaiting": false,
  "trainId": "ktx:v1:...",   // 생략 시 '가장 빠른 빈자리' 자동 모드
  "intervalSec": 15, "maxMinutes": 60
}
```

## 보안 / 정책 메모

- **자격증명은 실행 시 입력**하며 서버에 저장하지 않습니다. 매크로 실행 중에만
  해당 작업 객체 메모리에 보관되고, 작업이 끝나면 즉시 폐기됩니다. 로그에도
  남기지 않습니다(자식 프로세스 환경변수로만 전달, argv/쿼리 미사용).
- **과도한 폴링 금지**: 조회 간격은 최소 10초(기본 15초)로 제한되며, 최대 실행
  시간도 지정합니다. 코레일 anti-bot 정책을 존중합니다.
- **결제 미자동화**: 예약(좌석 선점)까지만 자동화합니다. 실제 결제는 사용자가
  코레일 앱/홈페이지에서 진행합니다.
- 공용/공유 서버가 아닌, 본인이 신뢰하는 환경에서만 사용하세요.
