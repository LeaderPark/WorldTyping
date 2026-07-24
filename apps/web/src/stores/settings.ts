// spec: docs/03 §4.3(SettingsState 전문), §7.1(platform 휴리스틱), §8.1(테마/lang 동기화),
//       docs/00 §11-D6(lang 단일 통합 설정), WT-M2-05
//
// localStorage persist(key 'wt:settings'). 고빈도 값(§4.5 불변식) 없음 — 저빈도 사용자 설정만.
// theme/lang은 FOUC 스니펫·LanguageGateOverlay가 zustand persist 하이드레이션을 기다리지 않고도
// 동기적으로 읽을 수 있도록 각각 원시 localStorage 키('wt:theme','wt:lang')에도 미러링한다.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { detectPlatform, type Platform } from '../lib/platform';

const THEME_KEY = 'wt:theme';
const LANG_GATE_KEY = 'wt:lang';
const DEVICE_ID_KEY = 'wt:did';

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // 사생활 모드 등 접근 자체가 throw하는 환경
  }
}

/** S2 언어 게이트가 이미 통과됐는지(localStorage 'wt:lang' 존재 여부). */
export function hasChosenLanguage(): boolean {
  return safeLocalStorage()?.getItem(LANG_GATE_KEY) != null;
}

function detectDefaultLang(): 'ko' | 'en' {
  if (typeof navigator === 'undefined' || !navigator.language) return 'ko';
  return navigator.language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

function readOrCreateDeviceId(): string {
  const store = safeLocalStorage();
  const existing = store?.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = crypto.randomUUID();
  store?.setItem(DEVICE_ID_KEY, id);
  return id;
}

export type Theme = 'dark' | 'light';
export type KeySound = 'off' | 'mech' | 'membrane';
export type FontScale = 0 | 1 | 2;

export interface VolumeSettings {
  master: number;
  sfx: number;
  bgm: number;
}

export interface SettingsState {
  lang: 'ko' | 'en';
  theme: Theme;
  reducedMotion: boolean | 'auto';
  highContrast: boolean;
  keySound: KeySound;
  volume: VolumeSettings;
  fontScale: FontScale;
  // [§11-D88] nickname 필드는 폐지됐다 — 표시/멀티 신원 닉네임은 계정(Google) 이름으로 일원화
  // (stores/auth). persist 'wt:settings'에 남은 기존 nickname 키는 상태 병합돼도 미참조라 무해
  // (마이그레이션 불필요).
  guestId: string;
  platform: Platform;
  /** 고스트 모드 토글(§9.3, WT-M5-04) — "아무 노선 완주 1회" 언락 후에만 BoardingPass가 노출.
   *  언락 여부 자체는 저장하지 않는다(stores/meta.ts trackBests에서 매번 판정, 단일 원천). */
  ghostMode: boolean;

  setLang(l: 'ko' | 'en'): void;
  setTheme(t: Theme): void;
  setReducedMotion(v: boolean | 'auto'): void;
  setHighContrast(v: boolean): void;
  setKeySound(v: KeySound): void;
  setVolume(v: Partial<VolumeSettings>): void;
  setFontScale(v: FontScale): void;
  setGhostMode(v: boolean): void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      lang: detectDefaultLang(),
      theme: 'light', // 라이트 모드 기본(docs/00 §11-D57 — docs/01 §13.2 "다크 기본"을 개정,
      // 다크는 옵션으로 존치·토글 동작 보존). 기존 localStorage에 저장된 값(예: 'dark')은
      // zustand persist 하이드레이션이 그대로 존중한다 — 이 기본값은 최초 방문자에게만 적용.
      reducedMotion: 'auto',
      highContrast: false,
      keySound: 'off',
      volume: { master: 0.8, sfx: 0.8, bgm: 0.5 },
      fontScale: 1,
      guestId: readOrCreateDeviceId(),
      platform: detectPlatform(),
      ghostMode: false,

      setLang: (l) => {
        safeLocalStorage()?.setItem(LANG_GATE_KEY, l);
        set({ lang: l });
      },
      setTheme: (t) => {
        safeLocalStorage()?.setItem(THEME_KEY, t);
        set({ theme: t });
      },
      setReducedMotion: (v) => set({ reducedMotion: v }),
      setHighContrast: (v) => set({ highContrast: v }),
      setKeySound: (v) => set({ keySound: v }),
      setVolume: (v) => set({ volume: { ...get().volume, ...v } }),
      setFontScale: (v) => set({ fontScale: v }),
      setGhostMode: (v) => set({ ghostMode: v }),
    }),
    { name: 'wt:settings' },
  ),
);
