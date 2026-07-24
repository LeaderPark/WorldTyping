// spec: docs/01 §8.2(로비→퀵매치/방 만들기/코드 참가→대기실 흐름)·§10.2(S9 와이어프레임), docs/05
//       §2.2(방 코드)·§2.3(퀵매치 REST)·§2.4(방 생성/참가·공개 목록), docs/00 §11-D8(REST 퀵매치+
//       /ws/room/:code)·D17(방코드)·D23(v1 race-mixed만 — 모드 선택 UI 노출 금지)·D68(멀티=로그인
//       필수·로비 재구성·방 제목), WT-M4-04 → WT-AUTH-05
//
// 이 화면은 REST 그랜트만 취득하고 실제 WS 연결은 RoomPage(WT-M4-04)가 소유한다 — useMultiplayer를
// 여기서 부르면 그 훅의 언마운트 클린업(wsRef.close)이 이 페이지를 떠나는 순간(= 방으로 라우팅
// 성공 직후) 소켓을 끊어버린다. 그래서 이 화면은 apiClient/ensureSession만 직접 쓰고, 받은 grant를
// `navigate(path, {state:{grant}})`로 넘겨 RoomPage가 그 grant로 연결하게 한다.
//
// [WT-AUTH-05] 로비 재디자인 + 멀티 로그인 게이트(§11-D68). 방 만들기/입장/퀵매치/코드 참가는 모두
// isLoggedIn을 먼저 검사하고, 비로그인이면 로그인 모달(reason=multi)을 띄운 뒤 성공 시 보류된 액션을
// 재개한다(withLoginGate). VITE_WS_BASE(E2E mock)에서는 게이트를 제외한다(구현 지시). 방 목록은
// GET /rooms/public이 주는 공개 방 상세(title/phase/hostCover)와 counts(공개/비공개)로 렌더하되,
// 비공개 방은 상세를 노출하지 않고 카운트만 보여준다(D68-⑧).
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiClient, ensureSession, ApiError } from '../../../net/api-client';
import { useSettingsStore } from '../../../stores/settings';
import { selectIsLoggedIn, useAuthStore, verifyAccountSession } from '../../../stores/auth';
import { multiErrorKey } from '../../../features/multiplayer/error-keys';
import type { WsGrant } from '../../../features/multiplayer/useMultiplayer';
import { Mascot } from '../../../components/Mascot';
import { PageHeader } from '../../../components/PageHeader';
import { CreateRoomModal, type CreateRoomOptions } from './CreateRoomModal';

/** 공개 방 목록 카드(workers/api/src/routes/multi.ts PublicRoomCard와 동형 — isPublic은 자명해 제외). */
interface PublicRoomCard {
  code: string;
  lang: string;
  players: number;
  maxPlayers: number;
  title: string | null;
  phase: string;
  hostCover: string | null;
}

interface PublicListRes {
  rooms: PublicRoomCard[];
  counts: { public: number; private: number };
}

type FilterTab = 'all' | 'public' | 'private';

/** v1 멀티 세트는 race-mixed 15개국 고정(docs/01 §8.1, docs/00 §11-D23) — 카드 메타 표시용 상수. */
const RACE_SET_SIZE = 15;

/** WT-DC-05(①): 퀵매치 매칭 화면 ETA 문구 값(디자인 S11 정본에서 추출) — 실시간 텔레메트리 소스가
 *  없어(v1 매칭은 REST 단발) 디자인 표기값을 상수로 고정한다. */
const MATCH_ETA_SECONDS = 10;
const MATCH_ONLINE_ESTIMATE = 132;

/** 방 코드 정규화 — 하이픈/공백 제거 + 대문자화. 6자면 코드 참가, 아니면 제목 필터로 취급(§2.2). */
function normalizeCode(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6);
}

export function LobbyPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lang = useSettingsStore((s) => s.lang);
  const guestId = useSettingsStore((s) => s.guestId);
  const settingsNickname = useSettingsStore((s) => s.nickname);
  const authNickname = useAuthStore((s) => s.nickname);

  // ── 멀티 로그인 게이트(§11-D68) ──
  const isLoggedIn = useAuthStore(selectIsLoggedIn);
  const openLogin = useAuthStore((s) => s.openLogin);
  const loginReason = useAuthStore((s) => s.loginReason);
  // E2E(mock WS 직결)는 로그인 게이트 제외 — 프로덕션 빌드엔 VITE_WS_BASE가 없어 항상 false다.
  const e2eBypass = Boolean(import.meta.env.VITE_WS_BASE);
  // 게이트에 막힌 액션을 보관했다가 로그인 성공 시 재개한다(취소 시 폐기).
  const pendingActionRef = useRef<(() => void) | null>(null);

  const [busy, setBusy] = useState(false);
  const [matching, setMatching] = useState(false);
  const matchCancelledRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterTab>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [publicRooms, setPublicRooms] = useState<PublicRoomCard[]>([]);
  const [counts, setCounts] = useState<{ public: number; private: number }>({ public: 0, private: 0 });

  // [§11-D86 F2] 멀티 진입 시 계정 토큰 1회 서버 검증 — 무효면 스토어가 로그아웃으로 강등되고
  // 배너/게이트/AuthChip이 같은 렌더 패스에서 guest로 정합화된다(사용자가 실패하는 클릭을 하기 전에).
  // 게스트(토큰 없음)는 no-op, e2eBypass와 무관하게 호출해도 무해하다(60s 메모로 방 진입과 중복 제거).
  useEffect(() => {
    void verifyAccountSession();
  }, []);

  useEffect(() => {
    let cancelled = false;
    function load(): void {
      apiClient
        .get<PublicListRes>('/rooms/public')
        .then((res) => {
          if (cancelled) return;
          setPublicRooms(res.rooms);
          setCounts(res.counts);
        })
        .catch(() => {
          // 공개 방 목록 실패는 비치명적 — 퀵매치/코드 참가는 계속 가능.
        });
    }
    load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // 로그인 성공 시 보류 액션 재개.
  useEffect(() => {
    if (isLoggedIn && pendingActionRef.current) {
      const action = pendingActionRef.current;
      pendingActionRef.current = null;
      action();
    }
  }, [isLoggedIn]);

  // 로그인 모달이 닫혔는데 여전히 비로그인이면(취소) 보류 액션을 폐기한다.
  useEffect(() => {
    if (loginReason === null && !isLoggedIn) pendingActionRef.current = null;
  }, [loginReason, isLoggedIn]);

  /** 로그인 게이트 — 로그인(또는 E2E)이면 즉시 실행, 아니면 액션을 보류하고 로그인 모달을 연다. */
  const withLoginGate = useCallback(
    (action: () => void): void => {
      if (e2eBypass || isLoggedIn) {
        action();
        return;
      }
      pendingActionRef.current = action;
      openLogin('multi');
    },
    [e2eBypass, isLoggedIn, openLogin],
  );

  function goToRoom(grant: WsGrant): void {
    navigate(`/multi/${grant.roomCode}`, { state: { grant } });
  }

  function reportError(err: unknown): void {
    if (err instanceof ApiError) setError(t(multiErrorKey(err.code)));
    else setError(t('multi.error.generic'));
  }

  async function runQuickMatch(): Promise<void> {
    setError(null);
    matchCancelledRef.current = false;
    setMatching(true);
    try {
      await ensureSession(guestId);
      const grant = await apiClient.post<WsGrant & { mode: string }>('/match/quick', { lang });
      if (matchCancelledRef.current) return; // 취소 후 도착 — 로비 유지.
      goToRoom(grant);
    } catch (err) {
      if (matchCancelledRef.current) return;
      reportError(err);
      setMatching(false);
    }
  }

  function cancelMatch(): void {
    matchCancelledRef.current = true;
    setMatching(false);
  }

  async function createRoom(opts: CreateRoomOptions): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await ensureSession(guestId);
      // 서버 CreateRoomSchema는 title이 z.string().min(1)이라 제목 없음은 키를 생략해야 한다(null 금지).
      const body: { lang: 'ko' | 'en'; maxPlayers: number; isPublic: boolean; title?: string } = {
        lang,
        maxPlayers: opts.maxPlayers,
        isPublic: opts.isPublic,
      };
      if (opts.title) body.title = opts.title;
      const grant = await apiClient.post<WsGrant>('/rooms', body);
      setCreateOpen(false);
      goToRoom(grant);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  async function joinByCode(code: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await ensureSession(guestId);
      const grant = await apiClient.post<WsGrant>(`/rooms/${code}/join`, {});
      goToRoom(grant);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  function onSearchSubmit(e: FormEvent): void {
    e.preventDefault();
    const code = normalizeCode(search);
    // 6자 = 코드 참가(게이트 통과 후). 그 외 입력은 제목 필터로만 동작한다(아래 visibleRooms).
    if (code.length === 6) {
      withLoginGate(() => void joinByCode(code));
    }
  }

  // 탭 + 검색어(제목)로 노출할 카드 계산. 비공개 탭은 상세 비노출(카운트만) — 카드는 항상 공개 방이다.
  const visibleRooms = useMemo<PublicRoomCard[]>(() => {
    if (filter === 'private') return [];
    const q = search.trim().toLowerCase();
    if (q === '') return publicRooms;
    return publicRooms.filter((r) => (r.title ?? '').toLowerCase().includes(q));
  }, [publicRooms, filter, search]);

  const totalCount = counts.public + counts.private;
  const defaultRoomTitle = (authNickname || settingsNickname || `GUEST_${guestId.slice(0, 4).toUpperCase()}`).slice(0, 24);

  if (matching) {
    // 퀵매치 매칭 화면(디자인 S11 정본) — 마스코트 bob + 타이틀 + ETA + 취소. 취소는 요청 결과를
    // 무시하고 로비로 복귀한다.
    return (
      <main
        className="wt-lobby-matching"
        data-testid="lobby-matching"
        role="status"
        aria-live="polite"
        style={{ '--wt-bob-dur': '1.4s' } as CSSProperties}
      >
        <Mascot width={64} tail="var(--continent-oceania)" bob />
        <p className="wt-lobby-matching__title">{t('multi.matching.title')}</p>
        <p className="wt-lobby-matching__eta">
          {t('multi.quickmatch.eta', { seconds: MATCH_ETA_SECONDS, online: MATCH_ONLINE_ESTIMATE })}
        </p>
        <button
          type="button"
          className="wt-lobby-matching__cancel"
          data-testid="lobby-matching-cancel"
          onClick={cancelMatch}
        >
          {t('multi.quickmatch.cancel')}
        </button>
      </main>
    );
  }

  return (
    // [Tweak C] flex-1·min-h-0로 뷰포트를 채워(AppShell flex 레이아웃) 방 목록만 내부 스크롤하게
    // 한다 — 헤더 카드는 고정, footer는 뷰포트 하단 유지. [D74] 폭은 공유 .wt-page로.
    <main className="wt-lobby min-h-0 flex-1 wt-page" data-testid="lobby-page">
      {/* [D74] 로비 상단 크롬을 공용 PageHeader로 통일 — 구 <TopBar back /> 배선 해제(TopBar 파일
          존치). [D75] 뒤로가기 링크 폐지 — 홈 이동은 좌상단 BrandMark로(자체 콘텐츠 h1 보유). */}
      <PageHeader />
      {/* 안내 배너 — 비로그인/로그인 분기(§11-D68 로비 재구성). */}
        <p
          className="wt-lobby__banner"
          data-testid="lobby-banner"
          data-variant={isLoggedIn ? 'member' : 'guest'}
        >
          {isLoggedIn ? t('lobby.banner.member') : t('lobby.banner.guest')}
        </p>

        {/* 방 목록 헤더 카드: 킥커 + 제목 + 부제 + 액션(멀티 랭킹 / 내 기록 / 방 만들기). */}
        <section className="wt-card wt-lobby__panel">
          <div className="wt-lobby__panel-head">
            <div className="wt-lobby__panel-heading">
              <span className="wt-kicker">{t('home.menu.multiKicker')}</span>
              <h1 className="wt-lobby__panel-title" tabIndex={-1}>
                {t('lobby.room.title')}
              </h1>
              <p className="wt-lobby__panel-subtitle">{t('lobby.hero.subtitle')}</p>
            </div>
            <div className="wt-lobby__panel-actions">
              {/* 멀티 랭킹: RankPage에 멀티 프리셀렉트가 없어 /rank 단순 링크로 폴백(WT-AUTH-05 에스컬레이션). */}
              <Link to="/rank" className="wt-pill wt-pill--compact" data-testid="lobby-rank-link">
                {t('menu.ranking')}
              </Link>
              <Link to="/passport" className="wt-pill wt-pill--compact" data-testid="lobby-passport-link">
                {t('menu.passport')}
              </Link>
              <button
                type="button"
                className="wt-pill wt-pill--active wt-pill--compact"
                data-testid="lobby-create-open"
                onClick={() => withLoginGate(() => setCreateOpen(true))}
              >
                <span aria-hidden="true">＋ </span>
                {t('lobby.create.title')}
              </button>
            </div>
          </div>

          {error && (
            <p className="wt-lobby__error" data-testid="lobby-error">
              {error}
            </p>
          )}

          {/* 퀵매치 스트립. */}
          <div className="wt-lobby__quickmatch">
            <button
              type="button"
              className="wt-pill wt-pill--active wt-lobby__quickmatch-cta"
              data-testid="lobby-quickmatch"
              disabled={busy || matching}
              onClick={() => withLoginGate(() => void runQuickMatch())}
            >
              {t('multi.quickmatch.start')}
            </button>
            <p className="wt-lobby__hint">{t('multi.quickmatch.hint')}</p>
          </div>

          {/* 검색바: 6자 코드=Enter 코드 참가 / 그 외 입력=제목 클라 필터. */}
          <form className="wt-lobby__search" onSubmit={onSearchSubmit}>
            <input
              type="text"
              value={search}
              placeholder={t('lobby.search.placeholder')}
              className="wt-lobby__search-input"
              data-testid="lobby-search"
              aria-label={t('lobby.search.placeholder')}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>

          {/* 필터 탭: 전체 / 공개방 / 비밀방(카운트). 비밀방은 상세 비노출 → 코드 참가 안내만. */}
          <div className="wt-lobby__filters" role="group" aria-label={t('lobby.room.title')}>
            {(['all', 'public', 'private'] as const).map((f) => {
              const n = f === 'all' ? totalCount : counts[f];
              return (
                <button
                  key={f}
                  type="button"
                  className={`wt-pill wt-pill--compact${filter === f ? ' wt-pill--active' : ''}`}
                  aria-pressed={filter === f}
                  data-testid={`lobby-filter-${f}`}
                  onClick={() => setFilter(f)}
                >
                  {t(`lobby.filter.${f}`)}
                  <span className="wt-lobby__filter-count">{n}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* 방 카드 리스트 / 비밀방 안내 / 빈 목록. [Tweak C] 이 영역만 내부 스크롤(flex-1·min-h-0·
            overflow-y-auto)한다 — 목록이 많으면 여기서 스크롤하고, 적거나 없어도 flex-1로 크기를
            유지해 헤더 카드/footer 위치가 흔들리지 않는다. tabIndex={0}은 axe scrollable-region-
            focusable(wcag2a) 대비(전 항목이 잠긴 방이라 포커서블 자식이 없어도 키보드로 스크롤 가능). */}
        <div className="wt-lobby__list" tabIndex={0}>
          {filter === 'private' ? (
            <p className="wt-lobby__notice" data-testid="lobby-private-hint">
              {t('multi.room.join')}
            </p>
          ) : visibleRooms.length === 0 ? (
            <p className="wt-lobby__notice" data-testid="lobby-empty">
              {t('multi.publicRooms.empty')}
            </p>
          ) : (
            <ul className="wt-lobby__rooms" data-testid="lobby-rooms">
              {visibleRooms.map((r) => {
              const joinable = r.phase === 'WAITING' || r.phase === 'CREATED';
              const roomLang = r.lang === 'en' ? 'en' : 'ko';
              return (
                <li key={r.code} className="wt-card wt-lobby-card" data-testid={`lobby-room-card-${r.code}`}>
                  <span className="wt-lobby-card__avatar" aria-hidden="true">
                    {(r.title ?? r.code).slice(0, 1).toUpperCase()}
                  </span>
                  <div className="wt-lobby-card__body">
                    <div className="wt-lobby-card__tags">
                      <span className="wt-lobby-card__badge wt-lobby-card__badge--race">{t('menu.multi')}</span>
                      <span className="wt-lobby-card__badge">{t('lobby.filter.public')}</span>
                      <span className="wt-lobby-card__code">{r.code}</span>
                    </div>
                    <p className="wt-lobby-card__title">{r.title ?? r.code}</p>
                    <p className="wt-lobby-card__sub">
                      {t('boarding.countries', { count: RACE_SET_SIZE })} · {t(`settings.inputLang.${roomLang}`)}
                    </p>
                  </div>
                  <div className="wt-lobby-card__right">
                    <span className="wt-lobby-card__passengers">
                      {t('lobby.room.passengers', { current: r.players, max: r.maxPlayers })}
                    </span>
                    {joinable ? (
                      <button
                        type="button"
                        className="wt-pill wt-pill--active wt-lobby-card__cta"
                        data-testid={`lobby-room-enter-${r.code}`}
                        disabled={busy}
                        onClick={() => withLoginGate(() => void joinByCode(r.code))}
                      >
                        {t('lobby.room.enter')}
                      </button>
                    ) : (
                      <span className="wt-lobby-card__locked" data-testid={`lobby-room-locked-${r.code}`}>
                        <span aria-hidden="true">🔒 </span>
                        {t('lobby.room.inProgress')}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
            </ul>
          )}
        </div>

        {createOpen && (
          <CreateRoomModal
            defaultTitle={defaultRoomTitle}
            busy={busy}
            onCreate={(opts) => void createRoom(opts)}
            onClose={() => setCreateOpen(false)}
          />
        )}
    </main>
  );
}

// React Router v6.4+ lazy route 계약: 모듈이 `Component`를 named export해야 한다(router.tsx).
export { LobbyPage as Component };
