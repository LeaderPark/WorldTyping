// spec: docs/01 §8.2("60초 내 상대 없으면 봇 매치 제안 — 고스트 리플레이 봇… 'GHOST' 라벨로
//       정직하게 표기"), docs/05 §2.3-5(봇 채우기 흐름), WT-M4-04
//
// S2C_BotOffer 수신 시 대기실 위에 뜨는 확인 모달. 수락/거절은 useMultiplayer().botAccept로
// 그대로 위임(판정 로직 없음 — 여기는 표시·입력만).
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { S2C_BotOffer } from '@wt/shared';
import { useModalA11y } from '../../lib/useModalA11y';

export interface BotOfferModalProps {
  offer: S2C_BotOffer;
  onAccept(): void;
  onDecline(): void;
}

export function BotOfferModal({ offer, onAccept, onDecline }: BotOfferModalProps) {
  const { t } = useTranslation();
  const [secondsLeft, setSecondsLeft] = useState(() => remainingSeconds(offer.expiresAt));
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // 배경 inert + 포커스 트랩 + 닫힘(수락/거절/만료로 언마운트) 시 트리거로 복귀(§7.3).
  useModalA11y(dialogRef, true);

  useEffect(() => {
    setSecondsLeft(remainingSeconds(offer.expiresAt));
    const id = setInterval(() => {
      setSecondsLeft(remainingSeconds(offer.expiresAt));
    }, 250);
    return () => clearInterval(id);
  }, [offer.expiresAt]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="wt-bot-offer-title"
      aria-describedby="wt-bot-offer-body"
      className="wt-bot-offer"
      data-testid="bot-offer-modal"
    >
      <div className="wt-bot-offer__box">
        <span className="wt-bot-offer__badge">{t('bot.offer.badge')}</span>
        <p id="wt-bot-offer-title" className="wt-bot-offer__title">
          {t('bot.offer.title')}
        </p>
        <p id="wt-bot-offer-body" className="wt-bot-offer__body">
          {t('bot.offer.body')}
        </p>
        <p className="wt-bot-offer__countdown" data-testid="bot-offer-countdown">
          {secondsLeft}
        </p>
        <div className="wt-bot-offer__actions">
          <button type="button" className="wt-btn wt-btn--primary" data-testid="bot-offer-accept" onClick={onAccept}>
            {t('bot.offer.accept')}
          </button>
          <button type="button" className="wt-btn" data-testid="bot-offer-decline" onClick={onDecline}>
            {t('bot.offer.decline')}
          </button>
        </div>
      </div>
    </div>
  );
}

function remainingSeconds(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}
