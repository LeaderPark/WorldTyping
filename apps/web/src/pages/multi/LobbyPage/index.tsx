// spec: docs/01 §8.2(로비→퀵매치/방 만들기/코드 참가→대기실 흐름)·§10.2(S9 와이어프레임), docs/05
//       §2.2(방 코드 3-3 하이픈 표시)·§2.3(퀵매치 REST)·§2.4(방 생성/참가·공개 목록), docs/00
//       §11-D8(REST 퀵매치+/ws/room/:code)·D17(방코드)·D23(v1 race-mixed만 — 모드 선택 UI 노출
//       금지), WT-M4-04
//
// 이 화면은 REST 그랜트만 취득하고 실제 WS 연결은 RoomPage(WT-M4-04)가 소유한다 — useMultiplayer를
// 여기서 부르면 그 훅의 언마운트 클린업(wsRef.close)이 이 페이지를 떠나는 순간(= 방으로 라우팅
// 성공 직후) 소켓을 끊어버린다. 그래서 이 화면은 apiClient/ensureSession만 직접 쓰고, 받은 grant를
// `navigate(path, {state:{grant}})`로 넘겨 RoomPage가 그 grant로 연결하게 한다.
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiClient, ensureSession, ApiError } from '../../../net/api-client';
import { useSettingsStore } from '../../../stores/settings';
import { multiErrorKey } from '../../../features/multiplayer/error-keys';
import type { WsGrant } from '../../../features/multiplayer/useMultiplayer';

interface PublicRoomEntry {
  code: string;
  lang: string;
  players: number;
  maxPlayers: number;
}

/** 사용자 입력 코드 표시 정규화(하이픈/공백 제거+대문자화) — 유효성 검증 자체는 서버가 한다
 *  (ROOM_NOT_FOUND). 여기서는 "KX7-3QP" 3-3 하이픈 표시(§2.2)만 재현한다. */
function formatCodeInput(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6);
  return cleaned.length > 3 ? `${cleaned.slice(0, 3)}-${cleaned.slice(3)}` : cleaned;
}

export function LobbyPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lang = useSettingsStore((s) => s.lang);
  const guestId = useSettingsStore((s) => s.guestId);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [publicRooms, setPublicRooms] = useState<PublicRoomEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    function load(): void {
      apiClient
        .get<{ rooms: PublicRoomEntry[] }>('/rooms/public')
        .then((res) => {
          if (!cancelled) setPublicRooms(res.rooms);
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

  function goToRoom(grant: WsGrant): void {
    navigate(`/multi/${grant.roomCode}`, { state: { grant } });
  }

  function reportError(err: unknown): void {
    if (err instanceof ApiError) setError(t(multiErrorKey(err.code)));
    else setError(t('multi.error.generic'));
  }

  async function onQuickMatch(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await ensureSession(guestId);
      const grant = await apiClient.post<WsGrant & { mode: string }>('/match/quick', { lang });
      goToRoom(grant);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  }

  async function onCreateRoom(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await ensureSession(guestId);
      const grant = await apiClient.post<WsGrant>('/rooms', { lang, maxPlayers, isPublic });
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

  function onJoinSubmit(e: FormEvent): void {
    e.preventDefault();
    const code = codeInput.replace(/-/g, '');
    if (code.length !== 6) {
      setError(t('multi.error.room-not-found'));
      return;
    }
    void joinByCode(code);
  }

  return (
    <main className="wt-lobby" data-testid="lobby-page">
      <header className="wt-lobby__header">
        <Link to="/" data-testid="lobby-back-home" className="wt-lobby__back">
          {t('nav.back.home')}
        </Link>
      </header>

      {/* 히어로(WT-UI-08 ①) — 홈의 로고 카드와 같은 어휘(아이콘 타일+제목+카피)를 멀티 진입점에도 씀. */}
      <section className="wt-lobby__hero">
        <span className="wt-icon-tile wt-lobby__hero-icon" aria-hidden="true">⚔</span>
        <div className="wt-lobby__hero-body">
          <h1 className="wt-lobby__hero-title" tabIndex={-1}>{t('menu.multi')}</h1>
          <p className="wt-lobby__hero-subtitle">{t('lobby.hero.subtitle')}</p>
        </div>
      </section>

      {error && <p className="wt-lobby__error" data-testid="lobby-error">{error}</p>}

      <section className="wt-lobby__section wt-lobby__section--quickmatch">
        <button
          type="button"
          className="wt-pill wt-pill--active wt-lobby__quickmatch-cta"
          data-testid="lobby-quickmatch"
          disabled={busy}
          onClick={() => void onQuickMatch()}
        >
          {t('multi.quickmatch.start')}
        </button>
        <p className="wt-lobby__hint">{t('multi.quickmatch.hint')}</p>
      </section>

      <section className="wt-lobby__section">
        <h2 className="wt-lobby__section-title">{t('multi.room.create')}</h2>
        <form className="wt-lobby__row" onSubmit={(e) => void onCreateRoom(e)}>
          <label className="wt-lobby__field">
            {t('multi.create.maxPlayers', { count: maxPlayers })}
            <input
              type="range"
              min={2}
              max={8}
              value={maxPlayers}
              data-testid="lobby-create-maxplayers"
              onChange={(e) => setMaxPlayers(Number(e.target.value))}
            />
          </label>
          <label className="wt-lobby__field wt-lobby__field--inline">
            <input
              type="checkbox"
              checked={isPublic}
              data-testid="lobby-create-public"
              onChange={(e) => setIsPublic(e.target.checked)}
            />
            {t('multi.create.public')}
          </label>
          <button type="submit" className="wt-btn wt-btn--primary" data-testid="lobby-create-submit" disabled={busy}>
            {t('multi.room.create')}
          </button>
        </form>
      </section>

      <section className="wt-lobby__section">
        <h2 className="wt-lobby__section-title">{t('multi.room.join')}</h2>
        <form className="wt-lobby__row" onSubmit={onJoinSubmit}>
          <input
            type="text"
            value={codeInput}
            placeholder={t('multi.room.codeInput')}
            className="wt-lobby__code-input"
            data-testid="lobby-join-code"
            onChange={(e) => setCodeInput(formatCodeInput(e.target.value))}
          />
          <button type="submit" className="wt-btn wt-btn--primary" data-testid="lobby-join-submit" disabled={busy}>
            {t('multi.room.joinBtn')}
          </button>
        </form>
      </section>

      <section className="wt-lobby__section">
        <h2 className="wt-lobby__section-title">{t('multi.publicRooms.title')}</h2>
        {publicRooms.length === 0 && <p className="wt-lobby__empty-hint">{t('multi.publicRooms.empty')}</p>}
        <ul className="wt-lobby__public-list" data-testid="lobby-public-rooms">
          {publicRooms.map((r) => (
            <li key={r.code} className="wt-card wt-lobby__public-entry" data-testid={`lobby-public-room-${r.code}`}>
              <span className="wt-lobby__public-entry-info">
                {t('multi.publicRooms.entry', { code: r.code, current: r.players, max: r.maxPlayers, lang: r.lang })}
              </span>
              <button
                type="button"
                className="wt-pill wt-lobby__public-entry-cta"
                disabled={busy}
                onClick={() => void joinByCode(r.code)}
              >
                {t('multi.room.joinBtn')}
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

// React Router v6.4+ lazy route 계약: 모듈이 `Component`를 named export해야 한다(router.tsx).
export { LobbyPage as Component };
