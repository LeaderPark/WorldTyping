// @vitest-environment jsdom
//
// spec: docs/01 §10.2(S7 결과 전문), docs/03 §4.2(ResultView), docs/06 §3.1(verdict), WT-M2-06·
// WT-M3-06. GamePage.test.tsx가 전체 여정(엔진 실배선)을 커버하므로, 여기서는 ResultView 자신의
// 표시/액션 분기(체크포인트 이어하기 버튼, 제출/순위 표시, 닉네임 유도, 다른 노선/홈 내비게이션)를
// 엔진을 얕게 스텁하고 net 계층을 목킹해 단위 검증한다.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { GameSessionEngine, RunResult as EngineRunResult } from '@wt/engine';
import type { Country } from '@wt/shared';
import { AppProviders } from '../../app/providers';
import { useSettingsStore } from '../../stores/settings';
import { ResultView } from './ResultView';

const submitRunMock = vi.fn();
const checkNicknameMock = vi.fn();
const putNicknameMock = vi.fn();
vi.mock('../../net/api-client', () => ({
  submitRun: (...args: unknown[]) => submitRunMock(...args),
  checkNickname: (...args: unknown[]) => checkNicknameMock(...args),
  putNickname: (...args: unknown[]) => putNicknameMock(...args),
}));

const enqueuePendingMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../../net/pending-queue', () => ({
  enqueuePending: (...args: unknown[]) => enqueuePendingMock(...args),
}));

function mkEngine(checkpointResumeAvailable: boolean): {
  engine: GameSessionEngine;
  resume: ReturnType<typeof vi.fn>;
} {
  const resume = vi.fn();
  const engine = {
    getSnapshot: () => ({ checkpointResumeAvailable }),
    resumeFromCheckpoint: resume,
    buildSubmission: () => ({ token: '', perCountry: [], inputDigest: '{"n":0,"mean":0,"stdev":0,"p10":0,"p50":0,"p90":0,"burstMax":0}' }),
  } as unknown as GameSessionEngine;
  return { engine, resume };
}

const COUNTRIES: Country[] = [
  {
    id: 'KR', iso3: 'KOR', nameKo: '대한민국', nameEn: 'South Korea', aliasesKo: [], aliasesEn: [],
    continent: 'asia', subregion: '', difficultyTier: 1, capitalKo: '', capitalEn: '',
    flagEmoji: '🏳️', population: 0, latlng: [0, 0], mapFeatureId: null,
    acceptedInputsKo: ['대한민국'], acceptedInputsEn: ['south korea'],
  },
  {
    id: 'JP', iso3: 'JPN', nameKo: '일본', nameEn: 'Japan', aliasesKo: [], aliasesEn: [],
    continent: 'asia', subregion: '', difficultyTier: 1, capitalKo: '', capitalEn: '',
    flagEmoji: '🏳️', population: 0, latlng: [0, 0], mapFeatureId: null,
    acceptedInputsKo: ['일본'], acceptedInputsEn: ['japan'],
  },
];

function baseResult(overrides: Partial<EngineRunResult> = {}): EngineRunResult {
  return {
    mode: 'worldtour',
    lang: 'ko',
    outcome: 'gameover',
    practice: false,
    viaCheckpoint: false,
    stats: {
      totalKeystrokes: 10,
      correctKeystrokes: 8,
      elapsedMs: 5000,
      maxCombo: 1,
      countriesCleared: 1,
      countriesSkipped: 1,
      perCountry: [
        { code: 'KR', ms: 1000, errors: 0, skipped: false },
        { code: 'JP', ms: 2000, errors: 3, skipped: true },
      ],
    },
    score: {
      cpm: 200,
      acc: 0.8,
      pi: 128,
      grade: 'C',
      completed: false,
      baseScore: 500,
      accFactor: 0.64,
      comboFactor: 1.01,
      timeBonus: 0,
      finalScore: 323,
    },
    ...overrides,
  };
}

interface RenderOpts {
  retry?: ReturnType<typeof vi.fn>;
  runToken?: string | null;
  runTokenIssuedAt?: number | null;
  nickname?: string;
  mode?: 'continent' | 'tier' | 'worldtour' | 'daily';
}

function renderResult(engine: GameSessionEngine, result: EngineRunResult, opts: RenderOpts = {}) {
  const retry = opts.retry ?? vi.fn();
  const mode = opts.mode ?? 'worldtour';
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[`/play/${mode}/world`]}>
        <Routes>
          <Route path="/" element={<div data-testid="home-stub" />} />
          <Route path="/play/:mode" element={<div data-testid="track-select-stub" />} />
          <Route
            path="/play/:mode/:trackId"
            element={
              <ResultView
                engine={engine}
                result={result}
                countries={COUNTRIES}
                lang="ko"
                mode={mode}
                trackId="world"
                platform="desktop"
                finalLives={null}
                runToken={opts.runToken ?? null}
                runTokenIssuedAt={opts.runTokenIssuedAt ?? null}
                nickname={opts.nickname ?? 'GUEST_TEST'}
                retry={retry}
              />
            }
          />
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ResultView', () => {
  it('게임오버 라벨·최다 오타를 렌더하고 랭킹은 /rank 링크, 공유(desktop)는 활성 상태다', () => {
    useSettingsStore.getState().setLang('ko');
    const { engine } = mkEngine(false);
    renderResult(engine, baseResult());

    const card = screen.getByTestId('result-card');
    expect(card.textContent).toContain('라이프 소진');
    expect(card.textContent).toContain('일본'); // 최다 오타 국가(errors=3 > 0).
    expect(screen.getByTestId('result-ranking')).toHaveAttribute('href', '/rank');
    expect(screen.getByTestId('result-share')).not.toBeDisabled();
    expect(screen.getByTestId('share-card-desktop')).toBeInTheDocument();
    expect(screen.queryByTestId('result-resume')).not.toBeInTheDocument();
  });

  it('checkpointResumeAvailable이면 이어하기 버튼이 나타나고 클릭 시 engine.resumeFromCheckpoint를 호출한다', () => {
    useSettingsStore.getState().setLang('ko');
    const { engine, resume } = mkEngine(true);
    renderResult(engine, baseResult());

    const resumeBtn = screen.getByTestId('result-resume');
    act(() => fireEvent.click(resumeBtn));
    expect(resume).toHaveBeenCalledOnce();
  });

  it('R 키로 retry()가 호출된다', () => {
    useSettingsStore.getState().setLang('ko');
    const { engine } = mkEngine(false);
    const retry = vi.fn();
    renderResult(engine, baseResult(), { retry });

    act(() => fireEvent.keyDown(window, { key: 'r' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('"다른 노선"/"홈" 클릭 시 각각 /play/:mode, / 로 이동한다', () => {
    useSettingsStore.getState().setLang('ko');
    const { engine } = mkEngine(false);
    renderResult(engine, baseResult());

    act(() => fireEvent.click(screen.getByTestId('result-other-route')));
    expect(screen.getByTestId('track-select-stub')).toBeInTheDocument();
  });

  it('완주(completed) 결과는 "완주" 라벨을 표시한다', () => {
    useSettingsStore.getState().setLang('ko');
    const { engine } = mkEngine(false);
    renderResult(engine, baseResult({ outcome: 'completed' }));

    const card = screen.getByTestId('result-card');
    expect(card.textContent).toContain('완주');
    expect(card.textContent).not.toContain('라이프 소진');
  });

  // ── 제출 배선(WT-M3-06) ─────────────────────────────────────────────────
  describe('제출 배선', () => {
    it('runToken 없음(오프라인 출발) → 큐에 적재하고 "온라인 연결 시 자동 제출" 라벨', () => {
      useSettingsStore.getState().setLang('ko');
      const { engine } = mkEngine(false);
      renderResult(engine, baseResult(), { runToken: null });

      expect(screen.getByTestId('result-verdict-label').textContent).toBe('온라인 연결 시 자동 제출됩니다');
      expect(enqueuePendingMock).toHaveBeenCalledOnce();
      expect(submitRunMock).not.toHaveBeenCalled();
    });

    it('practice(클라 강등) 결과는 네트워크 없이 즉시 "연습 기록" 라벨', () => {
      useSettingsStore.getState().setLang('ko');
      const { engine } = mkEngine(false);
      renderResult(engine, baseResult({ practice: true }), { runToken: 'tok' });

      expect(screen.getByTestId('result-verdict-label').textContent).toBe('연습 기록');
      expect(submitRunMock).not.toHaveBeenCalled();
      expect(enqueuePendingMock).not.toHaveBeenCalled();
    });

    it('runToken 있음 → submitRun 호출, valid 응답 시 순위/백분위/개인최고 표시', async () => {
      useSettingsStore.getState().setLang('ko');
      const { engine } = mkEngine(false);
      submitRunMock.mockResolvedValue({
        verdict: 'valid', score: 500, pi: 400, cpm: 300, accMilli: 950, grade: 'A',
        completed: true, rank: 5, total: 50, isPersonalBest: true,
      });

      renderResult(engine, baseResult(), { runToken: 'tok', runTokenIssuedAt: Date.now() });

      await waitFor(() => expect(screen.getByTestId('result-rank')).toBeInTheDocument());
      expect(screen.getByTestId('result-rank').textContent).toContain('5위');
      expect(screen.getByTestId('result-rank').textContent).toContain('10%'); // 5/50=10%
      expect(screen.getByTestId('result-rank').textContent).toContain('개인 최고 기록!');
      expect(submitRunMock).toHaveBeenCalledWith(
        expect.objectContaining({ runToken: 'tok', clientScore: baseResult().score.finalScore }),
      );
    });

    it('rejected 응답은 "기록이 검토 중입니다"만 표시(순위 없음)', async () => {
      useSettingsStore.getState().setLang('ko');
      const { engine } = mkEngine(false);
      submitRunMock.mockResolvedValue({
        verdict: 'rejected', score: 0, pi: 0, cpm: 0, accMilli: 0, grade: 'D',
        completed: false, rank: null, total: null, isPersonalBest: null,
      });

      renderResult(engine, baseResult(), { runToken: 'tok', runTokenIssuedAt: Date.now() });

      await waitFor(() => expect(screen.getByTestId('result-verdict-label').textContent).toBe('기록이 검토 중입니다'));
      expect(screen.queryByTestId('result-rank')).not.toBeInTheDocument();
    });

    it('submitRun 네트워크 실패 → 큐에 적재하고 큐 라벨로 대체', async () => {
      useSettingsStore.getState().setLang('ko');
      const { engine } = mkEngine(false);
      submitRunMock.mockRejectedValue(new Error('network down'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      renderResult(engine, baseResult(), { runToken: 'tok', runTokenIssuedAt: Date.now() });

      await waitFor(() => expect(enqueuePendingMock).toHaveBeenCalledOnce());
      expect(screen.getByTestId('result-verdict-label').textContent).toBe('온라인 연결 시 자동 제출됩니다');
      warnSpy.mockRestore();
    });
  });

  // ── 데일리 공유 텍스트(docs/06 §2.3, WT-M5-04) ─────────────────────────────
  describe('데일리 공유 텍스트', () => {
    it('daily 모드 + shareText 응답 시 복사 버튼과 텍스트를 렌더한다', async () => {
      useSettingsStore.getState().setLang('ko');
      const { engine } = mkEngine(false);
      const shareText = 'TypeTrip 데일리 #1\n🟩🟩  2/2 완주\n⚡ 200타 · 🎯 100.0% · PI 200 (S)\n/daily';
      submitRunMock.mockResolvedValue({
        verdict: 'valid', score: 500, pi: 400, cpm: 300, accMilli: 950, grade: 'A',
        completed: true, rank: 5, total: 50, isPersonalBest: true, shareText,
      });

      renderResult(engine, baseResult(), { runToken: 'tok', runTokenIssuedAt: Date.now(), mode: 'daily' });

      await waitFor(() => expect(screen.getByTestId('daily-share-text')).toBeInTheDocument());
      expect(screen.getByTestId('daily-share-text').textContent).toContain('TypeTrip 데일리 #1');

      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: writeTextMock } });
      fireEvent.click(screen.getByTestId('daily-share-copy'));
      await waitFor(() => expect(writeTextMock).toHaveBeenCalledWith(shareText));
      expect(await screen.findByTestId('daily-share-copied')).toBeInTheDocument();
      vi.unstubAllGlobals();
    });

    it('daily가 아닌 모드에서는 shareText가 와도 렌더하지 않는다', async () => {
      useSettingsStore.getState().setLang('ko');
      const { engine } = mkEngine(false);
      submitRunMock.mockResolvedValue({
        verdict: 'valid', score: 500, pi: 400, cpm: 300, accMilli: 950, grade: 'A',
        completed: true, rank: 5, total: 50, isPersonalBest: true, shareText: 'should-not-render',
      });

      renderResult(engine, baseResult(), { runToken: 'tok', runTokenIssuedAt: Date.now(), mode: 'worldtour' });

      await waitFor(() => expect(screen.getByTestId('result-rank')).toBeInTheDocument());
      expect(screen.queryByTestId('daily-share-text')).not.toBeInTheDocument();
    });
  });

  // ── 닉네임 유도(구현 세부 지시 3) ───────────────────────────────────────────
  describe('닉네임 유도', () => {
    it('닉네임 미설정이면 유도 폼이 보이고, 설정되어 있으면 보이지 않는다', () => {
      useSettingsStore.getState().setLang('ko');
      const { engine } = mkEngine(false);
      const { unmount } = renderResult(engine, baseResult(), { nickname: '' });
      expect(screen.getByTestId('result-nickname-gate')).toBeInTheDocument();
      unmount();

      renderResult(engine, baseResult(), { nickname: 'NIMBUS' });
      expect(screen.queryByTestId('result-nickname-gate')).not.toBeInTheDocument();
    });

    it('check→put 성공 시 settings 스토어 닉네임이 갱신된다', async () => {
      useSettingsStore.getState().setLang('ko');
      checkNicknameMock.mockResolvedValue({ ok: true });
      putNicknameMock.mockResolvedValue({ nickname: 'NEWNAME' });
      const { engine } = mkEngine(false);
      renderResult(engine, baseResult(), { nickname: '' });

      const input = screen.getByTestId('result-nickname-input');
      fireEvent.change(input, { target: { value: 'NEWNAME' } });
      fireEvent.click(screen.getByTestId('result-nickname-submit'));

      await waitFor(() => expect(useSettingsStore.getState().nickname).toBe('NEWNAME'));
      expect(checkNicknameMock).toHaveBeenCalledWith('NEWNAME');
      expect(putNicknameMock).toHaveBeenCalledWith('NEWNAME');
    });

    it('check 실패(reason) 시 에러 메시지를 표시하고 스토어는 갱신하지 않는다', async () => {
      useSettingsStore.getState().setLang('ko');
      checkNicknameMock.mockResolvedValue({ ok: false, reason: 'TAKEN' });
      const { engine } = mkEngine(false);
      renderResult(engine, baseResult(), { nickname: '' });

      fireEvent.change(screen.getByTestId('result-nickname-input'), { target: { value: 'NIMBUS' } });
      fireEvent.click(screen.getByTestId('result-nickname-submit'));

      await waitFor(() => expect(screen.getByTestId('result-nickname-error')).toBeInTheDocument());
      expect(putNicknameMock).not.toHaveBeenCalled();
    });
  });
});
