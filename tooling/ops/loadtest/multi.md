# 멀티 부하 테스트 — k6 대신 room-sim.ts 재사용 (WT-M6-05)

> spec: docs/06 §10-#5(부하 테스트 (c) — 멀티 500 동시 방), docs/00 §11-D7(WS 프로토콜 전문은
> `packages/shared/protocol/messages.ts`가 유일 원천) + WT-M4-06

## 왜 k6가 아니라 room-sim.ts인가

k6는 `k6/ws`로 WebSocket 부하를 낼 수 있지만, 이 프로젝트의 멀티 프로토콜은 그 자체로
"판정·프로토콜 로직은 `packages/shared` 밖에서 재구현하지 않는다"(CLAUDE.md 절대 규칙,
docs/00 §11-D7)는 제약 아래 있다. k6 스크립트(goja 런타임)는 npm 패키지를 import할 수 없어,
아래 세 가지를 k6 스크립트 안에 **그대로 다시 손으로 옮겨 적어야** k6 시나리오가 성립한다:

1. 세션/WS 티켓 서명(`packages/shared/auth/token.ts`의 HMAC 포맷) — 재구현 시 서명 포맷이
   구현과 미묘하게 어긋나는 회귀가 나기 쉽다(WS 티켓은 방마다 재사용 불가라 서버가 실패를
   조용히 삼키지 않는다 — 바로 `INVALID_TICKET`류로 연결이 끊긴다).
2. 클라이언트 프레임 스키마(`packages/shared/protocol/{messages.ts,schemas.ts}`) — `hello`→
   `join`→`ready`→`start`→`progress` 상태 전이 순서 자체가 프로토콜의 일부(docs/05 §4).
3. WS Hibernation 특유의 타이밍(§5.2 코얼레싱 250ms tick, ping/pong autoResponse)은 실제
   `wrangler dev`(workerd)를 상대로 해야 의미가 있다 — k6/ws가 이 계층을 왜곡 없이 흉내 내려면
   결국 프로토콜 상태머신 전체를 재이식해야 한다.

`tooling/ops/loadtest/room-sim.ts`(WT-M4-06 산출물)는 이 문제를 Node 내장 `WebSocket` +
`@wt/shared`의 **실제 서명 함수를 소스 상대경로로 직접 import**해서 푼다(재구현이 아니라 재사용
— 파일 상단 주석 참조). 이미 100/300/500방 규모로 실행·검증까지 끝난 상태라, WT-M6-05는 이
스크립트를 그대로 재사용하고 **k6 3종 중 멀티만 새로 작성하지 않는다**(작업 지시 "multi.md:
room-sim 재사용 근거 명시"와 일치).

## 실행 절차 (재현)

```bash
pnpm --filter @wt/api run e2e:dev        # 별도 터미널: 격리 wrangler dev @ 8787(persist 리셋)

# 규모별 반복(WT-M4-06과 동일 파라미터) — 결과는 stdout의 `SIM_ROW ...` 한 줄로 요약된다.
ROOMS=100 RACE_SECONDS=12 node --import tsx tooling/ops/loadtest/room-sim.ts
ROOMS=300 CONNECT_BATCH=50 node --import tsx tooling/ops/loadtest/room-sim.ts
ROOMS=500 CONNECT_BATCH=50 node --import tsx tooling/ops/loadtest/room-sim.ts
```

- SLO(docs/00 §1.4): 멀티 tick E2E p95 **< 400ms**.
- 측정 방식·결과·한계(로컬 workerd 스모크임을 명시한 정직한 기록)는 이미
  `tooling/ops/loadtest-report.md`의 "멀티 레이스(room-sim)" 절에 있다(WT-M4-06 산출 그대로,
  이번 작업에서 재작성하지 않는다 — 재현 절차만 이 파일로 옮겨 3종 산출물 목록을 완성한다).

## staging 정식 실행과의 차이

로컬 스모크는 단일 workerd(콜로 배치·다중 리전 RTT 없음)라 "서버 로직이 규모에서 붕괴하지
않는다"는 스모크이지 프로덕션 지연 예측이 아니다(loadtest-report.md 한계 절 참조). staging
500방 정식 검증은 **원격 실행 불가 항목**(Cloudflare 미연결)이라 이 저장소에서는 수행할 수
없다 — `tooling/ops/loadtest-report.md`의 "staging 정식 실행 절차" 절에 room-sim.ts를 staging
오리진(`WT_BASE=https://<staging-origin>`)으로 겨냥해 재실행하는 절차를 남겼다(리드가 계정
연결 후 그대로 실행).
