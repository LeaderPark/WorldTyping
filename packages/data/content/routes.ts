// spec: docs/02 §5.2(순서 규칙)·§5.3(아시아 47 전문)·§5.4(유럽 45 전문)·§5.5(나머지 방법론),
//       docs/02 §6(세계일주 50 전문), docs/00 §11-D2(세계일주 50개국)·D3(대륙 국가 수·시작점), WT-M1-06
//
// 런타임 계산 없는 고정 순서 콘텐츠. 순서 자체가 콘텐츠다(지하철 노선처럼 한 줄로 이어지는 스네이크
// 경로). 아시아/유럽/세계일주는 docs/02 전문을 그대로 옮긴 것 — 임의 변경 금지. 아프리카/북미/남미/
// 오세아니아는 §5.5 방법론(스네이크 경로, 섬나라는 최근접 본토 뒤 삽입)으로 완성했다.
// 검증(집합 일치·중복·시작점·세계일주 계약)은 routes.test.ts + build-data.ts Step 7-(d)가 수행한다.

import type { CountryId, Continent } from '@wt/shared';

// docs/02 §5.3 전문 그대로 (47개, 시작점 KR — §11-D3)
export const ROUTE_ASIA: CountryId[] = [
  'KR', 'JP', 'KP', 'CN', 'MN', // 동아시아
  'PH', 'VN', 'LA', 'KH', 'TH', 'MM', 'MY', 'SG', 'BN', 'ID', 'TL', // 동남아시아
  'BD', 'BT', 'NP', 'IN', 'LK', 'MV', 'PK', 'AF', // 남아시아
  'TJ', 'KG', 'KZ', 'UZ', 'TM', // 중앙아시아
  'IR', 'AZ', 'AM', 'GE', 'TR', // 서진: 이란→캅카스→아나톨리아
  'IQ', 'SY', 'LB', 'IL', 'PS', 'JO', // 레반트
  'SA', 'KW', 'BH', 'QA', 'AE', 'OM', 'YE', // 아라비아반도
];

// docs/02 §5.4 전문 그대로 (45개, 시작점 PT — §11-D3)
export const ROUTE_EUROPE: CountryId[] = [
  'PT', 'ES', 'AD', 'FR', 'MC', // 이베리아→서유럽
  'IE', 'GB', 'IS', // 섬나라 클러스터
  'NL', 'BE', 'LU', 'DE', // 저지대→독일
  'DK', 'NO', 'SE', 'FI', // 북유럽
  'EE', 'LV', 'LT', 'PL', // 발트→폴란드
  'CZ', 'SK', 'AT', 'LI', 'CH', // 중부
  'IT', 'SM', 'VA', 'MT', // 이탈리아반도+몰타
  'SI', 'HR', 'BA', 'ME', 'AL', 'MK', 'GR', // 발칸 서안 남하
  'RS', 'BG', 'RO', 'HU', // 발칸 내륙 북상
  'MD', 'UA', 'BY', 'RU', 'CY', // 동유럽, 키프로스는 종점 보너스역
];

// docs/02 §5.5 방법론 확장 (54개, 시작점 EG — §11-D3). 명시된 앞 구간(EG→LY→TN→DZ→MA,
// MR→SN→…→NG, CM→GQ→GA→CG→CD, 남부 ZA, 동아프리카 MZ→MW→TZ→KE→ET 마무리)을 그대로 지키고,
// 나머지 사헬 내륙·중부 보정·동아프리카/혼 오브 아프리카 국가와 섬나라를 인접 구간에 삽입했다.
export const ROUTE_AFRICA: CountryId[] = [
  'EG', 'LY', 'TN', 'DZ', 'MA', // 북아프리카 서진
  'MR', 'SN', 'CV', 'GM', 'GW', 'GN', 'SL', 'LR', 'CI', 'GH', 'TG', 'BJ', 'NG', // 서아프리카 해안 남하(CV는 세네갈 앞바다 삽입)
  'ML', 'BF', 'NE', 'TD', 'CF', // 사헬·내륙 보정 동진
  'CM', 'GQ', 'ST', 'GA', 'CG', 'CD', // 중부(ST는 적도기니 앞바다 삽입)
  'AO', 'NA', 'BW', 'ZW', 'ZM', 'ZA', 'LS', 'SZ', // 남부
  'MZ', 'KM', 'MG', 'MU', 'MW', 'TZ', 'SC', 'BI', 'RW', 'UG', 'KE', 'SO', 'SS', 'SD', 'ER', 'DJ', 'ET', // 동아프리카 북상(섬나라 KM/MG/MU/SC 삽입) + 마무리(ET)
];

// docs/02 §5.5 방법론 확장 (23개, 시작점 CA — §11-D3). CA→US→MX→중미 남하→카리브 서→동을
// 그대로 지키고, 소앤틸리스 제도를 북→남으로 이어 TT에서 끝맺는다.
export const ROUTE_NORTH_AMERICA: CountryId[] = [
  'CA', 'US', 'MX', // 북미 본토
  'GT', 'BZ', 'SV', 'HN', 'NI', 'CR', 'PA', // 중미 남하
  'CU', 'JM', 'HT', 'DO', 'BS', // 카리브 서→동(대앤틸리스)
  'KN', 'AG', 'DM', 'LC', 'BB', 'VC', 'GD', 'TT', // 소앤틸리스 북→남
];

// docs/02 §5.5 전문 그대로 (12개, 시작점 CO — §11-D3). 북안 동진 후 대륙 시계방향.
export const ROUTE_SOUTH_AMERICA: CountryId[] = [
  'CO', 'VE', 'GY', 'SR', 'BR', 'PY', 'UY', 'AR', 'CL', 'BO', 'PE', 'EC',
];

// docs/02 §5.5 전문 그대로 (14개, 시작점 AU — §11-D3). 멜라네시아→폴리네시아→미크로네시아.
export const ROUTE_OCEANIA: CountryId[] = [
  'AU', 'NZ', 'PG', 'SB', 'VU', 'FJ', 'TO', 'WS', 'TV', 'KI', 'NR', 'MH', 'FM', 'PW',
];

// docs/02 §6 전문 그대로 (50개국, §11-D2). 첫 5개 = KR,JP,US,CA,MX.
// 완주 시 종착 연출: CN → 서울 도착.
export const ROUTE_WORLD_TOUR: CountryId[] = [
  // Leg 1 — 동아시아 출발, 태평양 횡단 (1–5)
  'KR', 'JP', 'US', 'CA', 'MX',
  // Leg 2 — 카리브·중미·남미 종단 (6–12)
  'CU', 'PA', 'CO', 'PE', 'BR', 'AR', 'CL',
  // Leg 3 — 남태평양 → 오세아니아 (13–14)
  'NZ', 'AU',
  // Leg 4 — 동남아시아 (15–20)
  'ID', 'SG', 'MY', 'TH', 'KH', 'VN',
  // Leg 5 — 남아시아 → 중동 (21–23)
  'IN', 'NP', 'AE',
  // Leg 6 — 아프리카 종단: 북동→동→남→북서 (24–27)
  'EG', 'KE', 'ZA', 'MA',
  // Leg 7 — 유럽 대순환: 남서단 → 북상 → 동진 → 남하 (28–44)
  'PT', 'ES', 'FR', 'GB', 'IE', 'IS', 'NO', 'SE', 'FI', 'EE',
  'PL', 'DE', 'NL', 'BE', 'CH', 'IT', 'GR',
  // Leg 8 — 실크로드 귀환 (45–50)
  'TR', 'GE', 'KZ', 'UZ', 'MN', 'CN',
]; // 50개국. 완주 시 종착 연출: CN → 서울 도착

export const CONTINENT_ROUTES: Record<Continent, CountryId[]> = {
  asia: ROUTE_ASIA,
  europe: ROUTE_EUROPE,
  africa: ROUTE_AFRICA,
  'north-america': ROUTE_NORTH_AMERICA,
  'south-america': ROUTE_SOUTH_AMERICA,
  oceania: ROUTE_OCEANIA,
};
