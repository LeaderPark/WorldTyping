#!/bin/sh
# spec: WT-HOST-01 (Fable 5 승인, 리드 승인 완료) — /data 일 1회 백업.
#
# 실행 주체: docker-compose.yml `backup` 서비스(alpine + apk로 설치한 sqlite/tar/coreutils).
# 스케줄: 그 서비스의 자체 crond(17:30 UTC = KST 02:30, docker-compose.yml command 참고)가
# 매일 자동 호출한다. 수동 1회 실행은 `docker compose exec backup /backup.sh`.
#
# /data는 이 컨테이너에 :ro로 마운트된다(docker-compose.yml `backup.volumes`) — wrangler dev가
# 그 안의 D1/DO sqlite 파일에 동시에 쓰고 있을 수 있으므로:
#   - *.sqlite(WAL/SHM 사이드카 제외) 본체는 우선 `sqlite3 -readonly ... .backup`으로 뜬다.
#     .backup은 WAL이 걸려 있어도 정합적인 단일 스냅샷 파일을 만든다(라이브 파일을 그대로
#     tar에 넣으면 쓰기 도중 파일을 낚아채 깨진 스냅샷이 될 수 있다) — -readonly는 /data가
#     실제로 ro라 read-write로 열면 실패하기 때문에 필수.
#   - [WT-HOST-01 실측, Windows Docker Desktop named volume] 활성 Durable Object SQLite
#     스토리지 파일(예: v3/do/<class>/<id>.sqlite, wrangler dev가 그 순간 열어 쓰고 있는 것)에
#     대해 `sqlite3 -readonly ... .backup`이 간헐적으로 "unable to open database file"
#     (SQLITE_CANTOPEN)로 실패하는 사례를 확인했다 — 같은 파일을 그냥 `cp`로 떠서 별도 경로에
#     열어 보면 정상 SQLite 파일로 읽힌다(내용 손상이 아니라 그 자리에서 여는 것 자체의 문제,
#     Docker Desktop for Windows의 named volume 백엔드 파일 잠금 프리미티브 이슈로 추정 —
#     리드에게 별도 보고). 그래서 `.backup`이 실패하면 조용히 그 파일을 건너뛰지 않고, 원본을
#     그대로 raw cp로 폴백해 최소한 무언가는 아카이브에 남긴다(완전 누락보다 낫다) — 대신 그
#     사실을 로그와 종료 코드로 분명히 남긴다(아래 FAILSAFE_COUNT).
#   - *.sqlite-wal/*.sqlite-shm 사이드카는 건너뛴다(.backup 성공 결과물은 그 자체로 완결된
#     단일 파일이라 사이드카가 불필요 — raw cp 폴백 시에도 사이드카가 없으면 다음 기동 시
#     wrangler/workerd가 알아서 WAL을 재생성하며 복구한다).
#   - 그 외 파일(예: wrangler --persist-to가 D1/KV/DO 옆에 남기는 부속 상태)은 단순 cp.
#
# 개별 파일 실패가 백업 전체를 중단시키지 않는다(부분 성공 > 전체 실패) — 대신 실패가 있었으면
# 아카이브는 만들되 exit 2로 종료해 `docker compose logs backup`/모니터링에서 눈에 띄게 한다.
#
# 14일(BACKUP_RETAIN_DAYS, 기본 14) 초과 아카이브는 정리한다.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
OUT_DIR="${BACKUP_DIR:-/backups}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
STAMP="$(date -u +%Y%m%d)"
STAGE_DIR="$(mktemp -d)"
FILE_LIST="$(mktemp)"
FAILSAFE_LOG="$(mktemp)"
ARCHIVE="${OUT_DIR}/wt-data-${STAMP}.tar.gz"

cleanup() {
  rm -rf "$STAGE_DIR"
  rm -f "$FILE_LIST" "$FAILSAFE_LOG"
}
trap cleanup EXIT

mkdir -p "$OUT_DIR"

if [ ! -d "$DATA_DIR" ] || [ -z "$(ls -A "$DATA_DIR" 2>/dev/null)" ]; then
  echo "[backup] ${DATA_DIR} is empty or missing (nothing persisted yet) — skipping this run."
  exit 0
fi

echo "[backup] staging ${DATA_DIR} -> ${STAGE_DIR}"
cd "$DATA_DIR"

# 파일 목록은 파이프(| while)가 아니라 임시 파일로 받는다 — `cmd | while read` 오른쪽은
# 서브셸이라 그 안에서 늘린 카운터가 바깥 셸에 반영되지 않는다(FAILSAFE_LOG 파일 자체에
# 실패를 기록하는 방식으로 우회 — 파일 I/O는 서브셸 여부와 무관하게 보인다).

# 1) sqlite 본체가 아닌 파일: 있는 그대로 복사.
find . -type f ! -name '*.sqlite' ! -name '*.sqlite-wal' ! -name '*.sqlite-shm' > "$FILE_LIST" 2>/dev/null || true
while IFS= read -r f; do
  mkdir -p "${STAGE_DIR}/$(dirname "$f")"
  if ! cp -a "$f" "${STAGE_DIR}/${f}" 2>/dev/null; then
    echo "cp failed: ${f}" >> "$FAILSAFE_LOG"
  fi
done < "$FILE_LIST"

# 2) sqlite 본체: 정합 스냅샷 우선(readonly 소스), 실패 시 raw cp 폴백(위 주석 참고).
find . -type f -name '*.sqlite' > "$FILE_LIST" 2>/dev/null || true
while IFS= read -r f; do
  mkdir -p "${STAGE_DIR}/$(dirname "$f")"
  echo "[backup] sqlite3 -readonly .backup: ${f}"
  if sqlite3 -readonly "$f" ".backup '${STAGE_DIR}/${f}'" 2>/dev/null; then
    continue
  fi
  echo "[backup] WARN: sqlite3 .backup failed for ${f} — falling back to raw cp (see script header for known Windows/Docker Desktop named-volume cause)" >&2
  if cp -a "$f" "${STAGE_DIR}/${f}" 2>/dev/null; then
    echo "sqlite backup fallback-to-cp: ${f}" >> "$FAILSAFE_LOG"
  else
    echo "sqlite backup AND fallback cp both failed: ${f}" >> "$FAILSAFE_LOG"
  fi
done < "$FILE_LIST"

cd "$STAGE_DIR"
tar -czf "$ARCHIVE" .
SIZE="$(du -h "$ARCHIVE" 2>/dev/null | cut -f1)"
echo "[backup] wrote ${ARCHIVE} (${SIZE:-?})"

echo "[backup] pruning archives older than ${RETAIN_DAYS}d in ${OUT_DIR}"
find "$OUT_DIR" -maxdepth 1 -type f -name 'wt-data-*.tar.gz' -mtime "+${RETAIN_DAYS}" -print -delete

FAILSAFE_COUNT=0
if [ -s "$FAILSAFE_LOG" ]; then
  FAILSAFE_COUNT=$(wc -l < "$FAILSAFE_LOG" | tr -d ' ')
  echo "[backup] WARN: ${FAILSAFE_COUNT} file(s) needed a fallback path this run:" >&2
  cat "$FAILSAFE_LOG" >&2
fi

echo "[backup] done."
if [ "$FAILSAFE_COUNT" -gt 0 ]; then
  exit 2
fi
