// @vitest-environment jsdom
//
// spec: docs/01 §11.1("랜딩 → 첫 타이핑까지 3클릭·15초 이내"), WT-M2-07 완료 조건("랜딩→언어
// 선택→싱글→노선→보딩패스 탭까지 3클릭 이내(언어 게이트 1탭 제외)") — 세션 환경 어댑테이션 3항
// ("15초 스톱워치는 클릭 수 계산을 컴포넌트 테스트로 검증, 실측은 E2E E1로 이관")의 등가물.
//
// [환경 메모] 이 여정을 실제로 createMemoryRouter 하나에서 Link 클릭을 연속 시뮬레이션하면(첫
// 클릭은 성공하지만) 두 번째 데이터 라우터 navigate()부터 이 jsdom+Node 조합에서
// "RequestInit: Expected signal to be an instance of AbortSignal" 미해결 크래시가 난다
// (router.test.tsx가 이미 문서화한 것과 같은 부류의 jsdom↔undici interop 이슈 — GamePage가
// useBlocker를 강제해 classic <MemoryRouter>로 우회할 수도 없다). 그래서 각 화면을 독립적으로
// 렌더링해 "이 화면의 링크가 정확히 다음 화면의 라우트를 가리키는가"를 이어 붙여 클릭 사슬을
// 정적으로 증명한다 — 실제 클릭 시뮬레이션이 확인하는 것과 결과적으로 동일한 사실(각 hop이
// 실제 <Link href>로 존재)을 검증하며, 프로덕션 라우터(app/router.tsx)의 실제 경로 패턴과
// 대조한다(harness 특이 크래시를 피하되 거짓 그린은 만들지 않는다).
//
// [발견한 충돌 — escalations에도 동일 내용 기재]
// docs/01 §10.1 화면 그래프는 S1(홈)→S3(모드 선택)→S4(노선 선택)→S5(보딩패스)→S6(인게임)를
// 별개 화면으로 강제한다(WT-M2-07 자신도 ModeSelectPage/TrackSelectPage를 별개 화면으로
// 채우라고 지시한다). 이 그래프를 그대로 따르면 언어 게이트 해제 이후 "보딩패스 탭"(=playing
// phase 진입, 첫 타이핑 가능 시점)까지 정확히 **4번**의 클릭이 필요하다(① 싱글플레이 카드
// ② 대륙별 노선 카드 ③ 특정 노선 링크 ④ 보딩패스 탭) — §11.1·본 작업 완료조건이 명시한
// "3클릭"과 구조적으로 맞지 않는다. docs/00 §11 D1~D29 중 이 불일치를 해소하는 결정은 없다.
// 코드에서 임의로 화면을 병합(S3/S4 통합 등)하지 않고, 실제 구현이 요구하는 클릭 수를 있는
// 그대로 계측·단언한다. "보딩패스 화면 도달"까지는 정확히 3클릭이므로 그 경계까지는 §11.1
// 목표와 일치하고, "탭까지 포함"하면 4클릭이라는 점을 아래 두 번째 테스트가 명시적으로 남긴다.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProviders } from './providers';
import { HomePage } from '../pages/HomePage';
import { ModeSelectPage } from '../pages/ModeSelectPage';
import { TrackSelectPage } from '../pages/TrackSelectPage';

function renderAt(path: string) {
  return render(
    <AppProviders>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/play" element={<ModeSelectPage />} />
          <Route path="/play/:mode" element={<TrackSelectPage />} />
        </Routes>
      </MemoryRouter>
    </AppProviders>,
  );
}

afterEach(() => cleanup());

describe('랜딩→첫 타이핑 여정의 클릭 사슬(§11.1, WT-M2-07 완료조건 등가물)', () => {
  it('① 홈 "싱글플레이" 카드 → /play(모드 선택)', () => {
    renderAt('/');
    expect(screen.getByTestId('home-card-single')).toHaveAttribute('href', '/play');
  });

  it('② 모드 선택 "대륙별 노선" 카드 → /play/continent(노선 선택)', () => {
    renderAt('/play');
    expect(screen.getByTestId('mode-card-continent')).toHaveAttribute('href', '/play/continent');
  });

  it('③ 노선 선택의 특정 노선 → /play/continent/:id(보딩패스 화면, GamePage 라우트 패턴과 일치)', () => {
    renderAt('/play/continent');
    const link = screen.getByTestId('track-item-continent-south-america');
    expect(link).toHaveAttribute('href', '/play/continent/south-america');
    // app/router.tsx의 실제 라우트 패턴("play/:mode/:trackId")과 세그먼트 수가 일치하는지 대조.
    expect(link.getAttribute('href')?.split('/').filter(Boolean)).toHaveLength(3);
  });

  it('①→②→③ 세 클릭으로 보딩패스 화면(S5)까지 도달한다 — §11.1 "3클릭"과 일치하는 구간', () => {
    renderAt('/');
    const step1 = screen.getByTestId('home-card-single').getAttribute('href');
    expect(step1).toBe('/play');

    renderAt(step1 as string);
    const step2 = screen.getByTestId('mode-card-continent').getAttribute('href');
    expect(step2).toBe('/play/continent');

    renderAt(step2 as string);
    const step3 = screen.getByTestId('track-item-continent-south-america').getAttribute('href');
    expect(step3).toBe('/play/continent/south-america');

    // step3가 GamePage 라우트(`play/:mode/:trackId`, S5 보딩패스)와 매칭됨은
    // pages/GamePage/GamePage.test.tsx가 renderGame('continent','south-america')로 이미
    // 실증한다 — 여기서는 "정확히 3개의 링크 hop"이라는 사슬 길이만 단언한다.
    expect([step1, step2, step3]).toHaveLength(3);
  });

  // ④ "보딩패스 탭"까지 포함하면 4클릭이다 — pages/GamePage/GamePage.test.tsx의 boardAndDepart()
  // (fireEvent.click(boarding-card) → countdown 3s → game-view/첫 타이핑 가능)가 그 마지막 hop을
  // 이미 검증한다. 이 파일의 ①②③(3클릭, §11.1 목표와 일치)에 그 4번째 hop을 이어 붙이면
  // 총 4클릭이 되어 "3클릭" 목표와 어긋난다는 것이 위 파일 상단 escalation의 근거다.
});
