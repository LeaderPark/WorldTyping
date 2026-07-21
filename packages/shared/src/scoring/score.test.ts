// spec: docs/01 §6.1(RunStats)·§6.2(FinalScore)·§6.3(등급), WT-M1-02 acceptance
// 골든 벡터 5세트(a~e)는 tooling/ci/golden-vectors.json에 커밋되어 있다(단일 원천).
// 각 vector의 "calculation" 필드에 수기 계산 근거가 있다 — 이 테스트는 그 결과값을
// computeScore와 대조한다. JSON은 정적 import 대신 readFileSync로 읽는다(rootDir 밖
// 경로를 tsc 컴파일 그래프에 편입시키지 않기 위함 — import.meta.url은 런타임 문자열일 뿐
// 정적 모듈 해석 대상이 아니다).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RunStats } from '../types/game';
import { computeScore, type ScoreCountry } from './score';

interface GoldenExpected {
  cpm: number;
  acc: number;
  pi: number;
  grade: string;
  completed: boolean;
  baseScore: number;
  accFactor: number;
  comboFactor: number;
  timeBonus: number;
  finalScore: number;
}

interface GoldenCase {
  id?: string;
  lang: 'ko' | 'en';
  countries: ScoreCountry[];
  stats: RunStats;
  expected: GoldenExpected;
  calculation: string;
}

interface GoldenVector extends Partial<GoldenCase> {
  id: string;
  description: string;
  cases?: GoldenCase[];
}

interface GoldenFile {
  vectors: GoldenVector[];
}

const vectorsUrl = new URL('../../../../tooling/ci/golden-vectors.json', import.meta.url);
const golden = JSON.parse(readFileSync(vectorsUrl, 'utf-8')) as GoldenFile;

/** 벡터를 {id, ...GoldenCase}[] 로 평탄화한다(플랫 vector는 케이스 1개, e는 cases[] 2개). */
function flatten(vectors: GoldenVector[]): Array<GoldenCase & { id: string }> {
  const out: Array<GoldenCase & { id: string }> = [];
  for (const v of vectors) {
    if (v.cases) {
      for (const c of v.cases) out.push({ ...c, id: c.id ?? v.id });
    } else {
      out.push({
        id: v.id,
        lang: v.lang!,
        countries: v.countries!,
        stats: v.stats!,
        expected: v.expected!,
        calculation: v.calculation!,
      });
    }
  }
  return out;
}

describe('computeScore — 골든 벡터 5세트 (WT-M1-02 (a)~(e))', () => {
  it('golden-vectors.json에 정확히 5세트(a~e)가 존재한다', () => {
    expect(golden.vectors).toHaveLength(5);
    const ids = golden.vectors.map((v) => v.id);
    expect(ids.some((id) => id.startsWith('a-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('b-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('c-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('d-'))).toBe(true);
    expect(ids.some((id) => id.startsWith('e-'))).toBe(true);
  });

  for (const c of flatten(golden.vectors)) {
    it(`${c.id}: computeScore가 expected와 일치한다`, () => {
      const result = computeScore(c.stats, c.countries, c.lang);
      expect(result.completed).toBe(c.expected.completed);
      expect(result.cpm).toBe(c.expected.cpm);
      expect(result.acc).toBeCloseTo(c.expected.acc, 9);
      expect(result.pi).toBe(c.expected.pi);
      expect(result.grade).toBe(c.expected.grade);
      expect(result.baseScore).toBeCloseTo(c.expected.baseScore, 6);
      expect(result.accFactor).toBeCloseTo(c.expected.accFactor, 9);
      expect(result.comboFactor).toBeCloseTo(c.expected.comboFactor, 9);
      expect(result.timeBonus).toBeCloseTo(c.expected.timeBonus, 6);
      expect(result.finalScore).toBe(c.expected.finalScore);
    });
  }
});

describe('computeScore — 경계값·계약(제약: 정수 타수 우선 합산, 나눗셈은 마지막)', () => {
  const peru: ScoreCountry = { nameKo: '', nameEn: 'peru', difficultyTier: 1 };

  it('elapsedMs<=0이면 CPM=0(0-division 가드)', () => {
    const stats: RunStats = {
      totalKeystrokes: 4,
      correctKeystrokes: 4,
      elapsedMs: 0,
      maxCombo: 1,
      countriesCleared: 1,
      countriesSkipped: 0,
      perCountry: [{ code: 'PE', ms: 0, errors: 0, skipped: false }],
    };
    expect(computeScore(stats, [peru], 'en').cpm).toBe(0);
  });

  it('totalKeystrokes<=0이면 ACC=0(0-division 가드), perCountry 비어있으면 미완주', () => {
    const stats: RunStats = {
      totalKeystrokes: 0,
      correctKeystrokes: 0,
      elapsedMs: 1000,
      maxCombo: 0,
      countriesCleared: 0,
      countriesSkipped: 0,
      perCountry: [],
    };
    const r = computeScore(stats, [peru], 'en');
    expect(r.acc).toBe(0);
    expect(r.completed).toBe(false);
    expect(r.timeBonus).toBe(0);
  });

  it('perCountry.length > countries.length은 계약 위반 → throw', () => {
    const stats: RunStats = {
      totalKeystrokes: 8,
      correctKeystrokes: 8,
      elapsedMs: 1000,
      maxCombo: 2,
      countriesCleared: 2,
      countriesSkipped: 0,
      perCountry: [
        { code: 'PE', ms: 500, errors: 0, skipped: false },
        { code: 'XX', ms: 500, errors: 0, skipped: false },
      ],
    };
    expect(() => computeScore(stats, [peru], 'en')).toThrow(/perCountry\.length/);
  });

  it('grade cfg 주입이 computeScore 결과에도 반영된다', () => {
    const stats: RunStats = {
      totalKeystrokes: 4,
      correctKeystrokes: 4,
      elapsedMs: 480, // CPM=floor(4*60000/480)=500, ACC=1 → PI=500
      maxCombo: 1,
      countriesCleared: 1,
      countriesSkipped: 0,
      perCountry: [{ code: 'PE', ms: 480, errors: 0, skipped: false }],
    };
    expect(computeScore(stats, [peru], 'en').grade).toBe('S'); // 기본 컷 450
    expect(
      computeScore(stats, [peru], 'en', { grade: { S: 501, A: 340, B: 230, C: 120 } }).grade,
    ).toBe('A');
  });
});
