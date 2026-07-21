// spec: docs/05(Matchmaker DO — 04의 LobbyDO 폐기, §11-D8) + docs/00 §6(do/Matchmaker.ts)
//       + WT-M0-02 [제약] "DO 본문 작성 금지(M4 소관)"
// 빈 스텁만 export한다. 실제 퀵매치 큐/티켓 로직은 WT-M4-02.

import type { Env } from "../env";

export class MatchmakerDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(_request: Request): Promise<Response> {
    return new Response("MatchmakerDO stub — see WT-M4-02", { status: 501 });
  }
}
