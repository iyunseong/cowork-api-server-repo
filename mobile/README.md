# KTX / SRT 자동 예매 — 안드로이드 앱 (Capacitor)

PC·서버 없이 **폰에 설치하는 앱 하나로** KTX(코레일) 또는 **SRT(수서고속철)** 빈자리를
자동으로 잡습니다. 앱 상단에서 운영사를 선택하면 해당 역 목록과 로그인으로 전환됩니다.
아래 설명은 KTX 기준이며, SRT도 동일하게 동작합니다(SRT는 NetFunnel 대기열을 자동 처리). 코레일
모바일 API로 폰이 직접 통신하며(공식 앱과 동일한 방식 + anti-bot 토큰), 예약(좌석
선점)까지만 자동화하고 **결제는 코레일 앱에서** 직접 합니다.

원래 k-skill `ktx-booking` 스킬은 컴퓨터에서 파이썬으로 도는 도구인데, 그 통신 로직을
**JS로 포팅해 폰 안에서 실행**되게 만든 것입니다. 포팅 정확도는 파이썬 원본과
바이트 단위로 대조 검증합니다(`test/`).

## 📲 설치 (비개발자용)

1. GitHub 저장소의 **Actions** 또는 **Releases**에서 자동 빌드된
   `ktx-auto-booking.apk` 를 폰으로 다운로드합니다.
   - 태그(`v1.0.0` 등)를 올리면 Releases에 APK가 첨부됩니다.
   - 일반 푸시는 Actions 실행 결과의 **Artifacts**에서 받을 수 있습니다.
2. 폰에서 APK를 열면 "출처를 알 수 없는 앱 설치" 허용을 물어봅니다 → 허용 후 설치.
   (디버그 서명 APK라 정상적으로 뜨는 경고입니다.)
3. 앱 실행 → 코레일 로그인 → 여정 선택 → **조회** → 열차 선택 또는
   **가장 빠른 빈자리 자동 예매**.
4. 앱을 내려도 백그라운드로 계속 시도하며, 예약되면 **알림**으로 알려줍니다.

> 백그라운드 지속·알림이 잘 되려면 최초 실행 시 알림 권한을 허용하고, 제조사에 따라
> **배터리 최적화 예외**를 켜 주세요(설정 → 앱 → KTX 자동예매 → 배터리 → 제한 없음).

## 🛠 구조

```
mobile/
  src/
    korail/   dynapath.js  crypto.js  errors.js  korail.js   # 코레일 클라이언트(JS 포팅)
    macro.js                                                 # 재시도 매크로 루프
    app.js                                                   # 기기 전용 글루(플러그인 연동)
    ui/       index.html  styles.css                         # 화면
  scripts/build-www.js    # src -> www 조립(번들러 없이 ES 모듈 그대로)
  test/       parity.test.js  client.test.js  macro.test.js  reference.py
  capacitor.config.ts
.github/workflows/android.yml   # 테스트 + APK 자동 빌드
```

- **네이티브 HTTP**(CapacitorHttp)로 코레일에 요청 → WebView CORS 제약 없음, 세션 쿠키 유지.
- **로컬 알림**(LocalNotifications)으로 예약 완료 알람.
- 로그인 정보는 "이 기기에 기억" 선택 시에만 `@capacitor/preferences`(기기 내부 저장)에
  저장되며, 서버가 없으므로 외부로 전송되지 않습니다.

## 🧪 개발/검증

```bash
cd mobile
npm install
# 로직 검증(파이썬 원본과 크립토/토큰 대조 + 매크로 흐름):
python3 -m pip install korail2-ncard pycryptodome
npm test
# APK 빌드(안드로이드 SDK 필요 — 보통은 CI에 맡깁니다):
npm run apk   # www 빌드 -> cap sync -> gradlew assembleDebug
```

CI(`.github/workflows/android.yml`)가 위 테스트와 APK 빌드를 자동으로 수행합니다.

## ⚠️ 주의

- 자동 예매·anti-bot 우회는 코레일 약관 위반 소지가 있고 계정 제재 위험이 있습니다.
  과도한 반복 조회를 피하도록 조회 간격 하한(10초)과 최대 실행 시간을 둡니다.
  **개인 용도로만** 사용하세요.
- **결제는 자동화하지 않습니다.** 예약 성공 후 코레일 앱/홈페이지에서 결제하세요.
- 코레일이 anti-bot 규칙을 바꾸면 토큰 로직 갱신이 필요할 수 있습니다(원 스킬과 동일).
- 백그라운드 지속은 안드로이드/제조사별 편차가 있어 실제 기기에서 확인이 필요합니다.
