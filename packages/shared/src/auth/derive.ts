// spec: docs/04 §5.1(playerId = base58(HMAC-SHA256(SESSION_HMAC_SECRET, "pid:" + deviceId))[0:12]),
//       docs/00 §11-D10(device_hash = base58(HMAC(SESSION_HMAC_SECRET, deviceId)) UNIQUE, 원문 비저장),
//       WT-M1-04
//
// deviceId 원문은 서버에 저장되지 않는다(§10 프라이버시). 두 파생값 모두 SESSION_HMAC_SECRET을 쓰되
// 메시지 프리픽스로 도메인을 분리한다: playerId="pid:"+deviceId, device_hash=deviceId(프리픽스 없음).
// 같은 secret이라도 서로 무관한 값이 나와, 하나로 다른 하나를 역산할 수 없다.

import { bytesToBase58 } from './base58';
import { hmacSign } from './hmac';

const PID_LENGTH = 12;

/**
 * 익명 플레이어 ID. base58(HMAC(secret, "pid:" + deviceId))의 앞 12자.
 * 결정적: 같은 (secret, deviceId) → 항상 같은 12자(디바이스 삭제 후 같은 id 재제출 시 기록 연속).
 */
export async function derivePlayerId(secret: string, deviceId: string): Promise<string> {
  const mac = await hmacSign(secret, 'pid:' + deviceId);
  return bytesToBase58(mac).slice(0, PID_LENGTH);
}

/**
 * D1 users.device_hash 저장용 파생값(docs/00 §11-D10). base58(HMAC(secret, deviceId)) 전체.
 * UNIQUE 제약으로 디바이스 유일성을 판정하되 deviceId 원문은 저장하지 않는다.
 */
export async function deriveDeviceHash(secret: string, deviceId: string): Promise<string> {
  const mac = await hmacSign(secret, deviceId);
  return bytesToBase58(mac);
}
