// spec: docs/06 §1.3(runs.run_id = UUIDv7 — 시간정렬 가능), docs/04 §6.1(rid) + WT-M3-03
//
// UUIDv7(RFC 9562): 48-bit Unix ms 타임스탬프 프리픽스 + 버전/변이 비트 + 나머지 난수.
// 시간정렬성이 run_id/rid의 인덱스 지역성(idx_runs_user created_at DESC)과 잘 맞는다.
// crypto.randomUUID()는 v4(비정렬)라 여기서 v7을 직접 조립한다.

/** RFC 9562 UUIDv7 문자열(소문자, 하이픈 포함)을 생성한다. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 48-bit ms 타임스탬프(big-endian)를 앞 6바이트에.
  const ts = Math.floor(now);
  bytes[0] = (ts / 0x10000000000) & 0xff;
  bytes[1] = (ts / 0x100000000) & 0xff;
  bytes[2] = (ts / 0x1000000) & 0xff;
  bytes[3] = (ts / 0x10000) & 0xff;
  bytes[4] = (ts / 0x100) & 0xff;
  bytes[5] = ts & 0xff;

  // version(7)을 상위 니블에, variant(10xx)를 설정.
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
