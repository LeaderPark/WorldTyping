// spec: docs/02 §4.1 (인지도 점수 R 규칙 기반 가산), WT-M1-05
//
// R(0-100) 시드 생성기. 규칙: G20 +40 / OECD +20 / 인천 직항 +15 /
// FIFA 월드컵 본선(1998-2026) +15 / 하계 올림픽 개최 +10, 100 클램프.
// 이 헬퍼가 만든 값을 overrides/recognition.json 으로 커밋하고(사람 검수·조정),
// 빌드는 그 override 파일을 최종 원천으로 읽는다(§4.1). 멤버십 집합은 재현성의 원천이다.

/** G20 국가 회원(EU 제외 19개국) */
export const G20 = new Set([
  'AR', 'AU', 'BR', 'CA', 'CN', 'FR', 'DE', 'IN', 'ID', 'IT',
  'JP', 'KR', 'MX', 'RU', 'SA', 'ZA', 'TR', 'GB', 'US',
]);

/** OECD 회원 38개국 */
export const OECD = new Set([
  'AT', 'AU', 'BE', 'CA', 'CL', 'CO', 'CR', 'CZ', 'DK', 'EE',
  'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IL', 'IT', 'JP',
  'KR', 'LV', 'LT', 'LU', 'MX', 'NL', 'NZ', 'NO', 'PL', 'PT',
  'SK', 'SI', 'ES', 'SE', 'CH', 'TR', 'GB', 'US',
]);

/** 인천국제공항 직항 노선 존재 국가(2025 기준 대표 세트) */
export const INCHEON_DIRECT = new Set([
  'JP', 'CN', 'TW', 'VN', 'TH', 'PH', 'ID', 'MY', 'SG', 'KH',
  'LA', 'MM', 'IN', 'BD', 'LK', 'MV', 'NP', 'KZ', 'UZ', 'MN',
  'US', 'CA', 'GB', 'FR', 'DE', 'NL', 'IT', 'ES', 'FI', 'TR',
  'RU', 'AE', 'QA', 'SA', 'ET', 'KE', 'AU', 'NZ', 'FJ', 'PW',
  'BN', 'IL',
]);

/** FIFA 월드컵 본선 진출 이력(1998-2026) 대표 세트 */
export const WORLD_CUP = new Set([
  'FR', 'BR', 'DE', 'IT', 'ES', 'AR', 'GB', 'NL', 'PT', 'BE',
  'HR', 'UY', 'MX', 'US', 'KR', 'JP', 'AU', 'SN', 'GH', 'NG',
  'CM', 'CI', 'MA', 'TN', 'DZ', 'EG', 'ZA', 'CR', 'HN', 'EC',
  'CO', 'PY', 'CL', 'PE', 'IR', 'SA', 'QA', 'TR', 'RU', 'PL',
  'RS', 'CH', 'SE', 'DK', 'IE', 'SK', 'CZ', 'UA', 'GR', 'SI',
  'BA', 'IS', 'CA', 'PA', 'JM', 'TT', 'AO', 'TG', 'NZ', 'NO',
]);

/** 하계 올림픽 개최 이력 국가 */
export const OLYMPIC_HOST = new Set([
  'GR', 'AU', 'US', 'GB', 'CN', 'BR', 'JP', 'FR', 'FI', 'SE',
  'IT', 'DE', 'MX', 'KR', 'ES', 'CA', 'RU', 'NL', 'BE',
]);

/** 단일 국가의 R 시드 값을 규칙 가산으로 계산(0-100 클램프). */
export function seedRecognitionFor(id: string): number {
  let r = 0;
  if (G20.has(id)) r += 40;
  if (OECD.has(id)) r += 20;
  if (INCHEON_DIRECT.has(id)) r += 15;
  if (WORLD_CUP.has(id)) r += 15;
  if (OLYMPIC_HOST.has(id)) r += 10;
  return Math.min(r, 100);
}

/** id 리스트 전체의 R 시드 맵. overrides/recognition.json 재생성용. */
export function seedRecognition(ids: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of [...ids].sort()) out[id] = seedRecognitionFor(id);
  return out;
}
