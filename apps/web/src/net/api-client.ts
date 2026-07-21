// spec: docs/04 §2.1(공통 규약 — ApiError 포맷/베이스 경로), docs/00 §11-D18(도메인은
//       PUBLIC_ORIGIN 변수, 오리진 하드코딩 금지), WT-M2-05
//
// fetch 래퍼 + ApiError 파싱. 동일 오리진 설계(§2.1 "prod에선 CORS 불필요")라 base는 상대
// 경로 "/api/v1"로 고정 — 오리진은 항상 현재 페이지 오리진을 그대로 쓴다(하드코딩 금지 원칙).

const API_BASE = '/api/v1';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryAfterSec?: number;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSec: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterSec?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error?: unknown }).error === 'object'
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = path.startsWith('/api/') ? path : `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // 서버가 JSON이 아닌 에러 바디를 준 경우(프록시 502 HTML 등) — 상태 텍스트로 폴백.
    }
    if (isApiErrorBody(body)) {
      throw new ApiError(res.status, body.error.code, body.error.message, body.error.retryAfterSec);
    }
    throw new ApiError(res.status, 'UNKNOWN', res.statusText || `HTTP ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const apiClient = {
  get: <T>(path: string): Promise<T> => request<T>(path),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
};
