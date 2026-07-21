<!-- spec: docs/00 §10.2(Definition of Done) + docs/07 §0.4 공통 프리앰블 + WT-M0-03 -->

## 작업 ID / 관련 문서

- 작업 ID: <!-- 예: WT-M1-03 -->
- 참고 문서 좌표: <!-- 예: docs/05 §4.2 -->

## 변경 요약

<!-- 무엇을/왜 바꿨는지 2~3줄 -->

## Definition of Done (docs/00 §10.2)

- [ ] typecheck / lint / unit / 통합 테스트 그린 (`pnpm typecheck && pnpm lint && pnpm test`)
- [ ] 커버리지 게이트 충족 (`packages/shared`·`data`·`engine` line 95%+, 그 외 60%+)
- [ ] 웹 변경 시 size-limit 통과 (entry JS < 170KB gzip)
- [ ] 핫패스 규약 위반 없음 — 고빈도 값(입력 버퍼/CPM/콤보/경과시간)을 React state·Zustand에 넣지 않음 (docs/03 §4.5)
- [ ] D1 마이그레이션은 append-only (기존 `migrations/000N_*.sql` 수정·삭제 없음)
- [ ] 계약(스키마/프로토콜/공식) 변경 시 해당 docs + `docs/00` §11 동기 갱신

## 금지 사항 체크 (docs/07 §0.4 공통 프리앰블)

- [ ] `packages/shared` / `packages/engine`에 React·DOM 의존을 추가하지 않음
- [ ] 정답 매칭·점수 로직을 `packages/shared` 밖에 복제하지 않음
- [ ] 시크릿 값을 코드/`wrangler.toml`/문서에 기재하지 않음
- [ ] 런타임 외부 네트워크 의존을 추가하지 않음(데이터 빌드는 npm 패키지 + 저장소 내 파일만)

## Acceptance 실행 로그

<!-- 이번 작업 블록의 acceptance 명령과 실행 결과(핵심 로그 요지)를 붙여넣는다 -->

```
$ <command>
<output>
```

## 문서 간 충돌/미정의 발견 (있다면)

<!-- 발견한 충돌 / 제안하는 결정 / 근거. 없으면 "없음"으로 표기 -->
