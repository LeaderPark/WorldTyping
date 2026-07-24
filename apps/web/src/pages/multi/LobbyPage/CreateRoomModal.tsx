// spec: docs/01 §8.2(호스트가 인원/공개여부 설정)·§10.2(S9 로비), docs/05 §2.4(방 생성 body —
//       title/maxPlayers/isPublic), docs/00 §11-D23(모드 선택 UI 없음)·§11-D68-⑧(방 제목), WT-AUTH-05
//
// 방 만들기 모달. 로비의 "+ 방 만들기"가 로그인 게이트를 통과한 뒤 연다(비로그인은 이 모달에 도달하지
// 못한다). 제목/최대 인원/공개여부만 받는다 — v1은 race-mixed 고정이라 모드 선택 UI는 없다(D23).
// 제목 기본값은 닉네임 파생값(데이터)이라 하드코딩 UI 문자열이 아니다. 제목을 비우면(트림 후 빈 문자열)
// null로 넘겨 "제목 없는 방"으로 만든다(서버는 title 미지정을 허용).
//
// a11y: role=dialog + aria-modal, useModalA11y(포커스 트랩·배경 inert·트리거 복귀), ESC 닫기.

import { useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useHotkeys } from '../../../lib/hotkeys';
import { useModalA11y } from '../../../lib/useModalA11y';

/** 방 제목 최대 길이 — 서버 CreateRoomSchema(z.string().min(1).max(24))와 동일. */
const TITLE_MAX = 24;
const MAX_PLAYERS_MIN = 2;
const MAX_PLAYERS_MAX = 8;

export interface CreateRoomOptions {
  title: string | null;
  maxPlayers: number;
  isPublic: boolean;
}

export interface CreateRoomModalProps {
  /** 제목 입력 기본값(닉네임 파생, ≤24자로 잘라 전달). */
  defaultTitle: string;
  /** 생성 요청이 진행 중이면 폼을 잠근다. */
  busy: boolean;
  onCreate(opts: CreateRoomOptions): void;
  onClose(): void;
}

export function CreateRoomModal({ defaultTitle, busy, onCreate, onClose }: CreateRoomModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [title, setTitle] = useState(() => defaultTitle.slice(0, TITLE_MAX));
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [isPublic, setIsPublic] = useState(false);

  useHotkeys({ Escape: onClose });
  useModalA11y(dialogRef, true);

  function onSubmit(e: FormEvent): void {
    e.preventDefault();
    if (busy) return;
    const trimmed = title.trim();
    onCreate({ title: trimmed.length > 0 ? trimmed : null, maxPlayers, isPublic });
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('lobby.create.title')}
      data-testid="lobby-create-modal"
      className="wt-modal-scrim"
    >
      <form className="wt-card wt-create-modal" onSubmit={onSubmit}>
        <h2 className="wt-create-modal__title">{t('lobby.create.title')}</h2>

        <label className="wt-lobby__field">
          <span className="wt-create-modal__label">{t('lobby.create.titlePlaceholder')}</span>
          <input
            type="text"
            value={title}
            maxLength={TITLE_MAX}
            placeholder={t('lobby.create.titlePlaceholder')}
            className="wt-create-modal__input"
            data-testid="lobby-create-title"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <label className="wt-lobby__field">
          <span className="wt-create-modal__label">{t('multi.create.maxPlayers', { count: maxPlayers })}</span>
          <input
            type="range"
            min={MAX_PLAYERS_MIN}
            max={MAX_PLAYERS_MAX}
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

        <div className="wt-create-modal__actions">
          <button
            type="button"
            className="wt-btn"
            data-testid="lobby-create-cancel"
            disabled={busy}
            onClick={onClose}
          >
            {t('auth.cancel')}
          </button>
          <button type="submit" className="wt-btn wt-btn--primary" data-testid="lobby-create-submit" disabled={busy}>
            {t('lobby.create.title')}
          </button>
        </div>
      </form>
    </div>
  );
}
