// spec: docs/01 §9.2(업적 24종), docs/06 §4.3(unlock_id = `ach:{id}`), WT-PASSPORT-DEV-1
//
// 이 테스트가 클라 표시 카탈로그와 서버 판정 카탈로그의 id 집합 동일성을 잠근다. 서버 모듈을
// import하지 못하는 이유(rootDir 밖 + Cloudflare 전역 타입)는 achievements-catalog.ts 상단 주석
// 참조 — 대신 서버 소스 텍스트를 파싱해 대조한다. 서버에서 업적이 추가/삭제/개명되면 여기서 깨진다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { catalogs } from '@wt/i18n';
import {
  ACHIEVEMENTS_CATALOG,
  ACHIEVEMENT_TOTAL,
  ACHIEVEMENT_UNLOCK_PREFIX,
  achievementI18nKey,
  unlockedAchievementIds,
} from './achievements-catalog';

const SERVER_ACHIEVEMENTS_PATH = fileURLToPath(
  new URL('../../../../../workers/api/src/lib/achievements.ts', import.meta.url),
);

/** workers/api/src/lib/achievements.ts의 `export const ACHIEVEMENTS = [...] as const;`에서 id만 뽑는다. */
function serverAchievementIds(): string[] {
  const src = readFileSync(SERVER_ACHIEVEMENTS_PATH, 'utf8');
  const block = /export const ACHIEVEMENTS = \[([\s\S]*?)\] as const;/.exec(src);
  if (!block) throw new Error('서버 ACHIEVEMENTS 배열을 찾지 못했다 — 파싱 규약이 깨졌다.');
  const ids = [...block[1]!.matchAll(/id:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]!);
  if (ids.length === 0) throw new Error('서버 ACHIEVEMENTS에서 id를 하나도 못 뽑았다.');
  return ids;
}

describe('achievements catalog', () => {
  it('docs/01 §9.2의 24종을 수록한다', () => {
    expect(ACHIEVEMENTS_CATALOG).toHaveLength(24);
    expect(ACHIEVEMENT_TOTAL).toBe(24);
  });

  it('id가 유일하다', () => {
    const ids = ACHIEVEMENTS_CATALOG.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('아이콘(이모지)이 전부 비어있지 않고 서로 겹치지 않는다', () => {
    const icons = ACHIEVEMENTS_CATALOG.map((a) => a.icon);
    for (const icon of icons) expect(icon.length).toBeGreaterThan(0);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('서버 lib/achievements.ts의 id 집합과 완전히 일치한다(순서 포함)', () => {
    const server = serverAchievementIds();
    expect(server).toHaveLength(24);
    expect(ACHIEVEMENTS_CATALOG.map((a) => a.id)).toEqual(server);
  });

  it('모든 항목의 name/desc i18n 키가 ko/en 양쪽에 존재한다', () => {
    for (const entry of ACHIEVEMENTS_CATALOG) {
      for (const part of ['name', 'desc'] as const) {
        const key = achievementI18nKey(entry.id, part);
        expect(catalogs.ko[key], `ko.json에 ${key} 없음`).toBeTruthy();
        expect(catalogs.en[key], `en.json에 ${key} 없음`).toBeTruthy();
      }
    }
  });

  it('i18n 키는 snake_case id를 kebab-case로 변환해 만든다(키 규약 — 밑줄 불가)', () => {
    expect(achievementI18nKey('speed_demon_500', 'name')).toBe('achv.speed-demon-500.name');
    expect(achievementI18nKey('night_owl', 'desc')).toBe('achv.night-owl.desc');
  });
});

describe('unlockedAchievementIds', () => {
  it('achievement 타입만 골라 `ach:` 프리픽스를 제거한다', () => {
    const set = unlockedAchievementIds([
      { type: 'achievement', id: 'ach:first_flight' },
      { type: 'cover', id: 'cover:gold' },
      { type: 'stamp', id: 'stamp:continent:asia:A' },
      { type: 'achievement', id: 'ach:night_owl' },
    ]);
    expect([...set].sort()).toEqual(['first_flight', 'night_owl']);
  });

  it('프리픽스가 없는 형태도 그대로 받아들인다(방어적 — 표기 규약 이전 데이터)', () => {
    expect(ACHIEVEMENT_UNLOCK_PREFIX).toBe('ach:');
    const set = unlockedAchievementIds([{ type: 'achievement', id: 'first_win' }]);
    expect([...set]).toEqual(['first_win']);
  });

  it('빈 목록은 빈 집합', () => {
    expect(unlockedAchievementIds([]).size).toBe(0);
  });
});
