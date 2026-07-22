// spec: WT-M0-01 — 스캐폴드 상수 (실제 lib/*는 이후 마일스톤에서 채움)
// docs/00 §11-D18(WT-M6-06): 코드네임 WORLD TYPING은 저장소/문서 전용이고 사용자 노출 문자열은
// 전부 런칭명 TypeTrip을 쓴다 — 이 상수는 (현재 미사용이지만) 이름 그대로 "the app name"이라
// 노출 문자열 규칙을 따른다.
export const APP_NAME = "TypeTrip" as const;
