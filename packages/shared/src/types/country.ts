// spec: docs/02 §1 (국가 데이터 스키마), docs/00 §11-D19(경로: packages/shared)
// 이 타입은 빌드 산출물 countries.json / generated/countries.ts 및 클라·서버 판정의 공용 계약이다.

/** ISO 3166-1 alpha-2, 대문자. 게임 전역의 국가 기본 키 (예: "KR") */
export type CountryId = string;

export type Continent =
  | 'asia'
  | 'europe'
  | 'africa'
  | 'north-america'
  | 'south-america'
  | 'oceania';

export type DifficultyTier = 1 | 2 | 3 | 4 | 5;

export interface Country {
  /** ISO 3166-1 alpha-2 (대문자, 2자). 예: "KR" */
  id: CountryId;
  /** ISO 3166-1 alpha-3 (대문자, 3자). 예: "KOR" */
  iso3: string;
  /** 한국어 통용 국가명(외래어 표기법 기준 통용 표기). 예: "대한민국" */
  nameKo: string;
  /** 영어 통용 국가명(common name). 예: "South Korea" */
  nameEn: string;
  /**
   * 한국어 별칭. nameKo는 포함하지 않는다.
   * 예: ["한국", "남한"]
   */
  aliasesKo: string[];
  /**
   * 영어 별칭. nameEn은 포함하지 않는다.
   * 예: ["Korea", "Republic of Korea", "ROK"]
   */
  aliasesEn: string[];
  /** 게임 자체 대륙 구분(§5의 배정 규칙을 따른 최종값. 소스의 region을 그대로 쓰지 않음) */
  continent: Continent;
  /** UN M49 소지역명(영문). 예: "Eastern Asia". world-countries의 subregion 그대로 */
  subregion: string;
  /** 난이도 티어. §4의 방법론으로 산출 후 curated override 적용된 최종값 */
  difficultyTier: DifficultyTier;
  /** 수도 한국어명. 복수 수도는 대표 1개(행정수도 우선). 예: "서울" */
  capitalKo: string;
  /** 수도 영어명. 예: "Seoul" */
  capitalEn: string;
  /** 국기 이모지(리저널 인디케이터 2코드포인트). 예: "🇰🇷" */
  flagEmoji: string;
  /** 인구(정수, 최신 추정치. 소스: world-countries → override 가능) */
  population: number;
  /** [위도, 경도] (국가 중심점, world-countries latlng 그대로) */
  latlng: [number, number];
  /**
   * world-atlas(countries-110m.json) geometry의 id와 매칭하기 위한 값.
   * ISO 3166-1 numeric을 3자리 0-패딩 문자열로. 예: "410"(KR), "076"(BR).
   * topojson에 지오메트리가 없는 초소국(모나코 등)은 null → 지도에는 점(circle)으로 렌더.
   */
  mapFeatureId: string | null;
  /**
   * 정답으로 인정되는 한국어 입력 전체(정규화 완료 상태로 빌드 시 생성).
   * = normalizeKo(nameKo) ∪ normalizeKo(aliasesKo[]). 중복 제거, 원본 순서 유지.
   */
  acceptedInputsKo: string[];
  /**
   * 정답으로 인정되는 영어 입력 전체(정규화 완료 상태로 빌드 시 생성).
   * = normalizeEn(nameEn) ∪ normalizeEn(aliasesEn[]) ∪ 규칙 기반 변형(§3.4).
   */
  acceptedInputsEn: string[];
}

/** 빌드 산출물 countries.json의 루트 형태 */
export interface CountriesDataset {
  /** 데이터 스키마 버전. 매칭 로직과 호환성 체크에 사용 */
  schemaVersion: 2;
  /** 빌드 시각 ISO8601 */
  builtAt: string;
  /** 소스 패키지 버전 기록(재현성) */
  sources: { worldCountries: string; worldAtlas: string };
  countries: Country[];
}
