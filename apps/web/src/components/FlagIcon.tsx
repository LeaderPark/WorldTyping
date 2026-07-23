// spec: docs/00 §11-D64(국기 SVG 자산 — flag-icons 4x3, build-flags.mjs가 id 집합만 public/flags로
//       복사), docs/03 §3.6(레이아웃 프로퍼티 불변 — 크기 고정으로 리플로우 방지). WT-UI-03.
//
// Country.id(ISO2, 예 "KR")를 소문자화해 `/flags/{cc}.svg`(빌드 산출, build:flags)로 그린다. 자산이
// 없거나 로드 실패 시 1회만 flagEmoji로 폴백한다(무한 onError 루프 방지). 크기는 CSS(.wt-flag*)로
// 고정하고 img에도 width/height를 박아 로드 전/후 레이아웃 튐(리플로우)을 없앤다.
import { useState } from 'react';
import type { CountryId } from '@wt/shared';

export interface FlagIconProps {
  /** ISO2 국가 코드(Country.id). 소문자 파일명으로 매핑. */
  id: CountryId;
  /** 폴백용 유니코드 국기 이모지(Country.flagEmoji). */
  emoji: string;
  /** 접근성 이름. 지정하면 role=img로 노출, 미지정이면 장식(aria-hidden)으로 처리. */
  label?: string;
  /** 크기 프리셋(모두 4:3 비율 고정). 기본 md. */
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  /** testid 오버라이드(PromptArea가 기존 prompt-flag 계약 유지에 사용). 기본 flag-icon. */
  testId?: string;
}

export function FlagIcon({ id, emoji, label, size = 'md', className, testId = 'flag-icon' }: FlagIconProps) {
  const [failed, setFailed] = useState(false);
  const decorative = label == null;
  const cls = `wt-flag wt-flag--${size}${className ? ` ${className}` : ''}`;

  // 자산 실패(또는 코드 없음) → 이모지 폴백. 같은 고정 박스라 폴백 전환에도 리플로우가 없다.
  if (failed || !id) {
    return (
      <span
        className={`${cls} wt-flag--emoji`}
        data-testid={testId}
        data-fallback="emoji"
        {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}
      >
        {emoji}
      </span>
    );
  }

  return (
    <img
      className={cls}
      src={`/flags/${id.toLowerCase()}.svg`}
      alt={decorative ? '' : label}
      {...(decorative ? { 'aria-hidden': true } : {})}
      draggable={false}
      data-testid={testId}
      onError={() => setFailed(true)}
    />
  );
}
