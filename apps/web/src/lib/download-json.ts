// spec: docs/06 §6.3("내 데이터 내려받기" → JSON 파일 즉시 다운로드), WT-M6-01
//
// 서버가 이미 Content-Disposition: attachment 헤더로도 응답하지만(workers/api/src/routes/me.ts),
// fetch()로 받은 JSON은 브라우저의 네이티브 다운로드 대화상자를 자동으로 띄우지 않는다 — 클라
// 쪽에서 앵커(download 속성)를 합성 클릭해 실제 저장을 트리거한다. Blob+URL.createObjectURL
// 대신 data: URI를 쓰는 이유: (1) 별도 revokeObjectURL 정리가 필요 없고 (2) jsdom 단위테스트
// 환경에서도 동일하게 동작한다(Blob/createObjectURL은 jsdom 구현이 일관적이지 않음).
export function downloadJson(filename: string, data: unknown): void {
  const href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(data, null, 2))}`;
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
