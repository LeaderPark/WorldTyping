// spec: docs/00 §11-D72(footer 제자리 딤 스크림 모달 — URL·히스토리 불변), 설계 §2 결정 1·§3.4
//
// footer의 개인정보/약관/지원 클릭이 여는 제자리 오버레이. CreateRoomModal 패턴 재사용(로컬 state로
// 부모(SiteFooter)가 조건부 마운트 + .wt-modal-scrim + useModalA11y + useHotkeys(Escape)). 라우트
// 이동·pushState·?legal= 없음 — 클릭한 그 화면 위에 딤 스크림으로 뜬다. 닫기 3경로: ESC / 스크림
// 바깥 클릭 / 헤더 닫기 버튼. a11y: role=dialog + aria-modal + useModalA11y(초기 포커스=닫기 버튼·
// Tab 트랩·배경 inert·닫힘 시 트리거(footer 버튼) 포커스 복귀). 라우트 전환 시(모달 내부 /credits
// 링크 등) pathname effect가 자동으로 닫는다.
//
// [알려진 제약, 설계 §2 결정 4] /privacy 페이지 위에서 이 모달로 privacy를 열면 privacy-body-*·
// privacy-credits testid가 DOM에 2벌 존재한다(배경 쪽은 inert). 현행/신규 테스트 어느 것도 이 조합을
// 만들지 않는다 — 새 테스트에서 이 조합(직접 /privacy 진입 + footer로 privacy 모달 재오픈)은 피할 것.
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { useHotkeys } from '../../lib/hotkeys';
import { useModalA11y } from '../../lib/useModalA11y';
import { LegalArticle } from './LegalArticle';
import { LEGAL_DOCS, type LegalDocId } from './legal-docs';

export interface LegalModalProps {
  doc: LegalDocId;
  onClose(): void;
}

export function LegalModal({ doc, onClose }: LegalModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const entry = LEGAL_DOCS[doc];

  // 열려 있을 때만 마운트되므로 무조건 바인딩(CreateRoomModal과 동일).
  useHotkeys({ Escape: onClose });
  useModalA11y(dialogRef, true);

  // 라우트 전환 시 자동 닫힘 — 배경은 inert라 내비게이션은 모달 내부 링크(privacy의 /credits)에서만
  // 가능한데, 그때 "새 페이지 위에 모달이 남는" 어색함을 차단한다. 초회는 스킵(마운트 시 pathname 고정).
  const { pathname } = useLocation();
  const initialPathRef = useRef(pathname);
  useEffect(() => {
    if (pathname !== initialPathRef.current) onClose();
  }, [pathname, onClose]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t(entry.titleKey)}
      data-testid="legal-modal"
      className="wt-modal-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="wt-card wt-legal-modal">
        <div className="wt-legal-modal__header">
          <button
            type="button"
            data-testid="legal-modal-close"
            className="wt-legal-modal__close"
            onClick={onClose}
          >
            {t('common.close')}
          </button>
        </div>
        {/* 본문 스크롤 영역 — tabIndex={0}로 axe scrollable-region-focusable(wcag2a) 충족.
            문서 시각 제목은 md 첫 블록(# …)이 h2로 렌더되므로 헤더에 별도 헤딩을 두지 않는다. */}
        <div className="wt-legal-modal__body" tabIndex={0} data-testid="legal-modal-body">
          <LegalArticle doc={doc} />
        </div>
      </div>
    </div>
  );
}
