// spec: docs/01 §8.2(대기실 W — "참가자 슬롯에 닉네임+여권 커버+최근 PI… 레디 토글… 호스트는
//       인원/공개여부 설정" · "퀵매치는 4인 모이거나 15초 경과 시(2인 이상) 자동 시작. 60초 내
//       상대 없으면 봇 매치 제안")·§10.2(S10 와이어프레임), docs/05 §2.3(autoStartAt)·§2.3-5(bot-
//       offer), docs/00 §11-D23(v1 race-mixed 15개국 고정), WT-M4-04
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { RoomState } from '../../../stores/multiplayer';
import { useMultiplayerStore } from '../../../stores/multiplayer';
import { BotOfferModal } from '../../../features/multiplayer/BotOfferModal';
import type { useMultiplayer } from '../../../features/multiplayer/useMultiplayer';

/** v1 멀티 세트는 race-mixed 15개국 고정(docs/01 §8.1, docs/00 §11-D23) — 모드 선택 UI 자체가
 *  없으므로 여기서 상수로 표시한다(서버가 실제 세트를 확정하는 시점은 'start' 수신 시). */
const RACE_SET_SIZE = 15;

export interface WaitingRoomProps {
  room: RoomState;
  myPlayerId: string | null;
  mp: ReturnType<typeof useMultiplayer>;
  onLeave: () => void;
}

export function WaitingRoom({ room, myPlayerId, mp, onLeave }: WaitingRoomProps) {
  const { t } = useTranslation();
  const chatLog = useMultiplayerStore((s) => s.chatLog);
  const botOffer = useMultiplayerStore((s) => s.botOffer);
  const [chatText, setChatText] = useState('');
  const [copied, setCopied] = useState(false);
  const [autoStartLeft, setAutoStartLeft] = useState<number | null>(null);

  const me = room.players.find((p) => p.playerId === myPlayerId) ?? null;
  const isHost = myPlayerId !== null && myPlayerId === room.hostId;
  const maxPlayers = room.maxPlayers ?? 8;
  const emptySlots = Math.max(0, maxPlayers - room.players.length);

  useEffect(() => {
    if (room.autoStartAt === null) {
      setAutoStartLeft(null);
      return;
    }
    const tick = () => setAutoStartLeft(Math.max(0, Math.ceil((room.autoStartAt! - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [room.autoStartAt]);

  const inviteUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/multi/${room.code}` : `/multi/${room.code}`;

  async function copyInvite(): Promise<void> {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 클립보드 API 미지원/권한 거부 — 조용히 무시(사용자는 room.code를 직접 공유 가능).
    }
  }

  function sendChat(e: FormEvent): void {
    e.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    mp.chat(text);
    setChatText('');
  }

  return (
    <div className="wt-room" data-testid="waiting-room">
      <div className="wt-room__header">
        <span data-testid="room-code">{t('room.code', { code: room.code })}</span>
        <button type="button" className="wt-btn" data-testid="room-copy-code" onClick={copyInvite}>
          {copied ? t('room.copied') : t('room.copy')}
        </button>
        <button type="button" className="wt-btn" data-testid="room-share-link" onClick={copyInvite}>
          {t('room.shareLink')}
        </button>
        <span>{t('room.settings', { lang: room.lang, count: RACE_SET_SIZE, maxPlayers })}</span>
      </div>

      <div className="wt-waiting-room__slots" data-testid="waiting-room-slots">
        {room.players.map((p) => (
          <div
            key={p.playerId}
            className={`wt-waiting-slot${p.playerId === myPlayerId ? ' wt-waiting-slot--me' : ''}`}
            data-testid={`waiting-slot-${p.playerId}`}
          >
            <span>
              {p.playerId === myPlayerId ? t('room.hostMe') : p.isHost ? `${p.nickname} · ${t('room.player.host')}` : p.nickname}
              {p.isBot && ` · ${t('room.player.bot')}`}
            </span>
            <span className="wt-waiting-slot__ready">
              {p.connState === 'grace' ? t('room.spectator') : p.ready ? `✅ ${t('room.player.ready')}` : '⬜'}
            </span>
          </div>
        ))}
        {Array.from({ length: emptySlots }, (_, i) => (
          <div key={`empty-${i}`} className="wt-waiting-slot wt-waiting-slot--empty" data-testid={`waiting-slot-empty-${i}`}>
            {t('room.slot.empty')}
          </div>
        ))}
      </div>

      {autoStartLeft !== null && <p data-testid="waiting-autostart">{t('multi.countdown', { n: autoStartLeft })}</p>}

      <div className="wt-waiting-room__chat">
        <p>{t('room.chat.label')}</p>
        <div className="wt-waiting-room__chat-log" data-testid="waiting-chat-log">
          {chatLog.map((c, i) => {
            const from = room.players.find((p) => p.playerId === c.playerId);
            return (
              <p key={i}>
                <strong>{from?.nickname ?? c.playerId}</strong>: {c.text}
              </p>
            );
          })}
        </div>
        <form className="wt-waiting-room__chat-form" onSubmit={sendChat}>
          <input
            type="text"
            value={chatText}
            maxLength={120}
            placeholder={t('room.chat.placeholder')}
            data-testid="waiting-chat-input"
            onChange={(e) => setChatText(e.target.value)}
          />
          <button type="submit" className="wt-btn" data-testid="waiting-chat-send">
            {t('room.chat.input')}
          </button>
        </form>
      </div>

      <div className="wt-lobby__row">
        <button
          type="button"
          className={`wt-btn${me?.ready ? ' wt-btn--active' : ''}`}
          data-testid="waiting-ready-toggle"
          onClick={() => mp.ready(!me?.ready)}
        >
          {t('room.readyBtn')}
        </button>
        {isHost && (
          <button type="button" className="wt-btn wt-btn--primary" data-testid="waiting-start-btn" onClick={mp.startRace}>
            {t('room.startBtn')}
          </button>
        )}
        {!isHost && <span>{t('room.waitingHost')}</span>}
        <button type="button" className="wt-btn" data-testid="waiting-leave-btn" onClick={onLeave}>
          {t('room.leave')}
        </button>
      </div>

      {botOffer && (
        <BotOfferModal offer={botOffer} onAccept={() => mp.botAccept(true)} onDecline={() => mp.botAccept(false)} />
      )}
    </div>
  );
}
