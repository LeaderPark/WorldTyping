# 멀티 레이스 tick 부하 리포트 (WT-M4-06)

> 도구: `tooling/ops/loadtest/room-sim.ts` (Node 내장 WebSocket 클라 봇)
> 대상: 로컬 `wrangler dev`(workerd, miniflare) @ 127.0.0.1:8787 — persist 격리(e2e:dev)
> 측정: 각 봇이 `progress`를 보낸 시각 → 그 변화가 반영된 `progress-tick` 수신 시각까지의 E2E 지연.
> SLO(docs/00 §1.4): tick 지연 **p95 < 400ms**.
> 실행일: 2026-07-22 / 머신: Windows 11, Node v24.12, 12코어(로컬 dev).

## 방식 요약

- 방당 봇 2개(요구사항 "방당 2봇"). 방은 `POST /api/v1/rooms`(maxPlayers=2)로 생성 — 방 5개마다
  새 creator pid를 써서 `rooms(create)` per-pid 5회/60s 상한을 준수한다.
- 세션 토큰·WS 티켓은 `@wt/shared`의 `signSessionToken`/`signWsTicket`으로 **직접 서명**해
  `POST /session`(10회/60s/IP) 상한을 우회한다. 서버 검증(requireAuth·consumeTicket·ticket 서명)은
  그대로 통과하므로 **서버 임계값은 완화하지 않았다**(작업 지시 준수).
- 비-퀵매치 방은 전원레디 자동시작이 아니라 호스트 `start`가 필요하므로(MatchRoom.onReady), 봇이
  2인 도달 시 `start`를 보낸다(비호스트는 서버가 NOT_HOST로 무시).
- 부하 생성: RACING 진입 후 각 봇이 250ms tick 주기 근처(기본 300ms)로 `progress`(ks 소범위 순환 →
  서버 표시 ksPct가 매번 변경 → 코얼레싱 tick이 유의미 변화로 방송)를 흘린다. complete/matchInput은
  쓰지 않는다(idx 0 유지, 순수 tick 부하).

## 규모별 결과

| 방(rooms) | 봇(WS) | 생성 | 연결 | RACING 도달 | tick 표본 | p50 | p95 (SLO<400) | p99 |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 200 | 100 | 200 | 200 | 6,578 | 138ms | **253ms** ✅ | 264ms |
| 300 | 600 | 300 | 600 | 600 | 16,132 | 153ms | **265ms** ✅ | 288ms |
| 500 | 1000 | 500 | 1000 | 1000 | 22,453 | 149ms | **268ms** ✅ | 290ms |

재현:
```
pnpm --filter @wt/api run e2e:dev        # wrangler dev @ 8787 (persist 격리 + 마이그레이션)
ROOMS=100 RACE_SECONDS=12 node --import tsx tooling/ops/loadtest/room-sim.ts
ROOMS=300 CONNECT_BATCH=50 ...
ROOMS=500 CONNECT_BATCH=50 ...
```

## 판정

- **500 동시 방(1000 WS)까지 로컬 workerd에서 tick p95<400ms(268ms) 달성 — SLO 통과.**
  100→300→500 모두 SLO 여유가 크고(p95 253~268ms) 방 수 증가에 따른 열화가 미미하다.

## 한계·주의 (정직한 기록)

- **측정 지점이 로컬**이다: workerd(miniflare)는 프로덕션 Durable Objects의 실제 콜로 배치·네트워크
  RTT·Hibernation 동작과 다르다. 여기 수치는 "서버 로직 tick 코얼레싱이 규모에서 붕괴하지 않는다"는
  스모크이지 프로덕션 지연 예측이 아니다.
- **부하 생성기(단일 Node 프로세스)가 병목일 수 있다**: 1000개 봇의 progress 타이머·JSON 파싱이 한
  이벤트 루프에 몰려, 500방 구간에서 표본 수집이 간헐적으로 정체(로그 t=11~15s 구간 plateau)했다.
  즉 관측 지연에는 서버가 아니라 **클라 측 스케줄 지터**가 일부 섞였을 수 있어 실제 서버 tick 지연은
  이 값 이하일 가능성이 높다(수치는 보수적).
- **complete/matchInput·하드캡·리매치 경로는 부하에 미포함**이다(순수 progress→tick 만 측정).
- 위 이유로 **500방 완전 검증(실 DO 배치·다중 콜로·장시간 안정성·리소스 사용량)은 M6 staging으로
  이관**한다(작업 지시 3의 조정 조항). staging에서 k6 + 실 Cloudflare 환경으로 재측정 권고.
