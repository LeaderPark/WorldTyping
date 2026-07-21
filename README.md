# WORLD TYPING (런칭명: TypeTrip)

세계 지도 위에서 **국가 이름을 타이핑**하는 웹 브라우저 게임. 레퍼런스인 **METRO TYPING**(서울 지하철역 타이핑 게임, `subway-typing-game.web.app`)의 재미 구조를 계승하되, 지하철 역 대신 세계 국가를 사용하고 서버를 **Cloudflare 전면**으로 재구축한다.

이 저장소는 현재 **런칭 가능 수준의 설계 문서 + 구현 프롬프트**만 담고 있다 (코드 없음). `docs/07`의 작업 프롬프트를 순서대로 Claude Code(Sonnet/Opus) 세션에 넣으면 게임이 구현된다.

## v1 스코프 (한 번에 런칭)

- **싱글 3모드**: 대륙별(노선) · 난이도 티어별(서바이벌) · 세계일주 루트(마라톤) + 데일리 챌린지
- **멀티플레이**: 실시간 레이스 (2~8인, Cloudflare Durable Objects + WebSocket)
- **랭킹**: 모드/언어/기간별 리더보드, 서버 권위 안티치트
- **언어**: 한국어(IME 자모 판정) / 영어, 비로그인 100% 플레이

## 기술 스택 (요약)

프론트 `Vite + React 18 + TypeScript + Zustand + Tailwind + d3-geo` · 백엔드 `Cloudflare Workers + Hono + Durable Objects + D1 + KV` · `pnpm` 모노레포. 클라이언트와 서버가 `packages/shared`의 **동일한 판정·점수 코드**를 번들해 판정 불일치를 구조적으로 차단한다.

## 문서 인덱스

| 문서 | 내용 |
|---|---|
| **[CLAUDE.md](./CLAUDE.md)** | Claude Code 작업 규칙 · 모델 사용 정책 · 함정(gotchas) — 항상 먼저 읽을 것 |
| [docs/00-master-overview.md](./docs/00-master-overview.md) | 최상위 개요 · 아키텍처 · 로드맵 M0~M6 · **확정 결정 표(§11)** |
| [docs/01-game-design.md](./docs/01-game-design.md) | 게임 규칙 · 모드 · 점수 공식 · UX 흐름 |
| [docs/02-data-content.md](./docs/02-data-content.md) | 국가 데이터 스키마 · 매칭 규칙 · 티어 · 노선/루트 · 데이터 빌드 |
| [docs/03-frontend-architecture.md](./docs/03-frontend-architecture.md) | 클라 스택 · **한글 IME 입력 엔진** · 세계지도 렌더링 |
| [docs/04-backend-cloudflare.md](./docs/04-backend-cloudflare.md) | 인프라 · REST API · 세션/토큰 · wrangler · 배포 · 비용 |
| [docs/05-multiplayer-protocol.md](./docs/05-multiplayer-protocol.md) | WS 메시지 전문 · DO 상태머신 · 매치메이킹 · 서버 검증 |
| [docs/06-rankings-ops.md](./docs/06-rankings-ops.md) | 리더보드 · 안티치트 운영 · 프라이버시 · 런칭 체크리스트 |
| [docs/07-implementation-prompts.md](./docs/07-implementation-prompts.md) | **마일스톤별 42개 구현 프롬프트 + 모델 라우팅** (복붙 실행용) |

## 시작하는 법

1. `CLAUDE.md`와 `docs/00`을 먼저 읽는다.
2. `docs/07 §0` 사용법 가이드에 따라, `WT-M0-01`부터 순서대로 작업 프롬프트를 Claude Code 세션에 붙여넣는다.
3. 각 작업 블록 = PR 1개. 블록의 acceptance 조건을 통과시킨 뒤 머지한다.

## 모델 사용 정책

- **기획/설계 = Fable 5** — 이 문서들과 구현 프롬프트는 전부 Fable 5가 작성했다.
- **구현(코드) = Sonnet / Opus** — 작업별 모델 배정은 `docs/07 §0.2`를 따른다.
- 상세는 `CLAUDE.md`의 "모델 사용 정책" 참조.
