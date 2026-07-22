// spec: docs/06 §8.1(구조화 로그 컨벤션 `console.log(JSON.stringify({evt, sid, uid: uidHash, ...}))`),
//       docs/04 §8.2(Workers Logs — `console.log(JSON.stringify({evt, pid, rid, ...}))` 규약) +
//       WT-M6-04 구현 세부 지시 1
//
// 구조화 로그의 단일 헬퍼. 이 파일 밖에서 evt 로그를 남기고 싶은 코드는 반드시 log()/logError()를
// 거친다 — 산발적인 `console.log("[foo] ...")` 문자열 포맷을 금지하고 Workers Logs 대시보드 쿼리
// (`evt="run_rejected"` 등, docs/04 §8.2)가 항상 파싱 가능한 JSON 한 줄을 받게 한다.
//
// 원 userId/입력 내용은 절대 필드로 넘기지 말 것(호출부 책임) — uid는 항상 해시된 값만.
export type LogFields = Record<string, string | number | boolean | null | undefined>;

function emit(level: "log" | "warn" | "error", evt: string, fields?: LogFields): void {
  const payload = { evt, ts: Date.now(), ...fields };
  // eslint-disable-next-line no-console -- 구조화 로그의 유일한 출력 경로(Workers Logs/wrangler tail).
  console[level](JSON.stringify(payload));
}

/** 정보성 이벤트(정상 스킵 등). */
export function log(evt: string, fields?: LogFields): void {
  emit("log", evt, fields);
}

/** 경고 — 부가 기능 실패(텔레메트리·리포터 등, 요청 자체는 성공). */
export function logWarn(evt: string, fields?: LogFields): void {
  emit("warn", evt, fields);
}

/** 에러 — 알림 임계(docs/06 §8.2)에 걸릴 수 있는 실패. */
export function logError(evt: string, fields?: LogFields): void {
  emit("error", evt, fields);
}
