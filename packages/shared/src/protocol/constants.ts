// spec: docs/05 부록A(구현 파일 매니페스트 — constants.ts 값 목록),
//       docs/05 §4.4(TICK_MS/PROGRESS_THROTTLE_MS), §5(REACTION_FLOOR_MS/MAX_KPS, A3),
//       §7.1(GRACE_MS), §1(HARDCAP_MS), §4.2(PER_COUNTRY_LIMIT_MS),
//       §10.2(REMATCH_VOTE_MS), §2.3(AUTOSTART_WAIT_MS, BOT_OFFER_MS)
// WT-M1-03 — 클라·서버 공유 프로토콜 상수. 값 변경은 §11 결정 없이 임의로 하지 말 것.

/** progress-tick 브로드캐스트 주기(ms). 4Hz. */
export const TICK_MS = 250;

/** 클라의 progress 신고 최대 전송 주기(ms). 최대 10Hz. */
export const PROGRESS_THROTTLE_MS = 100;

/** COUNTDOWN/RACING 중 연결 끊김 시 유예 시간(ms). 만료 시 left 확정. */
export const GRACE_MS = 15_000;

/** 레이스 하드캡(ms). startAt + HARDCAP_MS 도달 시 전원 강제 종료. */
export const HARDCAP_MS = 180_000;

/** 국가 1개당 서버 제한 시간(ms). GDD §7.1. */
export const PER_COUNTRY_LIMIT_MS = 10_000;

/** 국가 완료 최소 소요시간 하한(ms) — 초인적 속도(봇) 방지 (A3). */
export const REACTION_FLOOR_MS = 250;

/** 언어별 최대 허용 타수(문자/자모 per second) — TOO_FAST 판정 상한 (A3). */
export const MAX_KPS: Readonly<Record<'ko' | 'en', number>> = { ko: 14, en: 18 };

/** FINISHED phase 리매치 투표 마감까지의 시간(ms). */
export const REMATCH_VOTE_MS = 30_000;

/** 퀵매치 2~3인 상태에서 자동 시작까지 대기하는 시간(ms). */
export const AUTOSTART_WAIT_MS = 15_000;

/** 1인 대기 상태에서 bot-offer를 제시하기까지의 시간(ms). */
export const BOT_OFFER_MS = 60_000;
