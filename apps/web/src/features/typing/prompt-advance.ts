// spec: docs/00 §11-D77 (프롬프트 캡슐 고정 폭·국가명 단일행, Tweak Q). 표시 전용 — 판정·점수·
//       프로토콜·엔진·prompt-renderer 계약 불변. WT-DC-10 세부 개정.
//
// [무엇] 한 국가명의 프롬프트 "진행폭(advance, em)"을 마운트당 1회 순수 산술로 계산한다. PromptArea가
// 국가 전환(저빈도) 리렌더에서 이 값을 `--wt-prompt-adv` CSS 변수로 주입하면, globals.css의 글리프
// font-size가 `min(clamp×fontScale, 100cqw/adv×0.98)`로 고정 폭 칼럼에 국가명을 정확히 한 줄에
// 수납한다(측정 0·transform 0·키스트로크 경로 무변경 — §4.5/§3.6 준수).
//
// [왜 별도 모듈] prompt-renderer.ts는 무수정 계약이므로 helper를 renderer 밖에 둔다. 판정 로직 복제가
// 아니라 표시 슬롯 기하(폭)만 계산하며, 구분자 판별은 prompt-renderer.unitLen과 동일 기법(@wt/shared의
// toJamoSeq/normalizeKo/normalizeEn — 자모 길이 0 = 공백·구두점)을 쓴다.
//
// [상수 = CSS 슬롯 기하와 1:1] 아래 em 상수는 globals.css의 .wt-unit(ko 1.14em / en 0.78em)·
// .wt-unit--sep(0.4em)·.wt-prompt__glyphs gap(0.14em)과 정확히 일치해야 한다. 어느 한쪽을 바꾸면
// 반드시 다른 쪽도 함께 바꾼다(드리프트 방어: 골든 테스트 prompt-advance.test.ts + 이 주석 상호 참조).
import { normalizeEn, normalizeKo, toJamoSeq } from '@wt/shared';

/** ko 콘텐츠 슬롯 폭(globals.css `.wt-unit` width). */
const KO_UNIT_EM = 1.14;
/** en 콘텐츠 슬롯 폭(globals.css `.wt-prompt[data-lang='en'] .wt-unit` width). */
const EN_UNIT_EM = 0.78;
/** 구분자(공백·구두점) 슬롯 폭(globals.css `.wt-unit--sep` width). */
const SEP_EM = 0.4;
/** 슬롯 간 gap(globals.css `.wt-prompt__glyphs` gap). */
const GAP_EM = 0.14;

/**
 * 국가명(캐노니컬 표기)의 프롬프트 진행폭(em). = Σ(슬롯 폭) + gap × 슬롯 수.
 *
 * 자식 = 슬롯 n개 + tail 1개 → 슬롯 사이 gap은 n개(tail 앞 gap 포함). prompt-renderer가 코드포인트
 * 단위로 슬롯을 만드는 것과 동일하게 `for..of`(코드포인트) 순회한다.
 *
 * 반환값은 2자리로 "올림"한다(언더슈트 = 폰트가 미세하게 커져 오버플로 나는 것 방지). 순수 십진
 * 산술이면 이미 2자리인 값(예 9.74)은 올림해도 그대로여야 하지만, 2진 부동소수 누적 오차가 ×100
 * 결과를 정수 바로 위로 밀어 Math.ceil이 1을 더 올리는 경우가 있다(9.74→9.75). 1e-6(= 1e-8 em,
 * 어떤 유의미한 폭 증분보다 훨씬 작음)만큼 빼서 그 미세 오차만 흡수하고, 진짜 소수부 초과는 그대로
 * 올린다 — 설계 §3.4 골든(9.74·27.92 등)이 설계 §4 폰트 산식이 가정한 값과 정확히 일치하게 한다.
 */
export function promptAdvanceEm(name: string, lang: 'ko' | 'en'): number {
  let em = 0;
  let slots = 0;
  for (const ch of name) {
    // 구분자 판별 = prompt-renderer.unitLen과 동일 기법(자모 길이 0 = 공백·구두점).
    const len = lang === 'ko' ? toJamoSeq(normalizeKo(ch)).length : normalizeEn(ch).length;
    em += len === 0 ? SEP_EM : lang === 'ko' ? KO_UNIT_EM : EN_UNIT_EM;
    slots++;
  }
  return Math.ceil((em + GAP_EM * slots) * 100 - 1e-6) / 100;
}
