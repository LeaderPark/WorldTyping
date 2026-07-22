// @vitest-environment jsdom
//
// spec: docs/06 §6.3("내 데이터 내려받기"), WT-M6-01
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadJson } from './download-json';

describe('downloadJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a temporary anchor with a data: URI href and the given filename, clicks it, then removes it', () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const bodyLengthBefore = document.body.childElementCount;

    downloadJson('typetrip-data-123.json', { a: 1, nested: { b: 'x' } });

    expect(clickSpy).toHaveBeenCalledTimes(1);
    // 클릭된 앵커는 트리거 직후 document에서 제거된다 — 잔존 노드가 없어야 한다.
    expect(document.body.childElementCount).toBe(bodyLengthBefore);
  });

  it('encodes the JSON payload into the href as a data: URI', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.href.startsWith('data:application/json;charset=utf-8,')).toBe(true);
      expect(decodeURIComponent(this.href.split(',')[1] ?? '')).toBe(JSON.stringify({ hello: 'world' }, null, 2));
      expect(this.download).toBe('f.json');
    });

    downloadJson('f.json', { hello: 'world' });
  });
});
