// spec: docs/05(MatchRoom DO 상태머신) + docs/00 §6(do/MatchRoom.ts) + WT-M0-02 [제약] "DO 본문 작성 금지(M4 소관)"
// 빈 스텁만 export한다. wrangler.toml의 durable_objects 바인딩/migrations가 클래스 존재를
// 요구하므로(파싱 통과 조건) 최소 껍데기만 둔다. 실제 상태머신/Hibernation은 WT-M4-01.

import type { Env } from "../env";

export class MatchRoomDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response("MatchRoomDO stub — see WT-M4-01", { status: 501 });
  }
}
