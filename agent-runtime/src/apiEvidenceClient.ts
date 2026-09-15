import { z } from 'zod';

const configSchema = z.object({
  apiUrl: z.string().url(),
  evidenceToken: z.string().min(20),
  instancePk: z.string().regex(/^[1-9]\d{0,18}$/),
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

export type EvidenceContext = z.infer<typeof configSchema>;
export const MAX_EVIDENCE_BYTES = 128 * 1024;
export const EVIDENCE_TIMEOUT_MS = 8_000;

export function contextFromEnvironment(): EvidenceContext {
  return configSchema.parse({
    apiUrl: process.env.PGSTAT_AGENT_API_URL,
    evidenceToken: process.env.PGSTAT_AGENT_EVIDENCE_TOKEN,
    instancePk: process.env.PGSTAT_AGENT_INSTANCE_PK,
    from: process.env.PGSTAT_AGENT_TIME_FROM,
    to: process.env.PGSTAT_AGENT_TIME_TO,
  });
}

const PATHS = {
  find_instance: '/instances',
  telemetry_coverage: '/telemetry-coverage',
  autovacuum_overview: '/autovacuum-overview',
  vacuum_candidates: '/vacuum-candidates',
  table_vacuum_evidence: '/table-vacuum-evidence',
} as const;
export type EvidenceTool = keyof typeof PATHS;

export class EvidenceApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`pgstat kanıt API: HTTP ${status} (${code})`);
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_EVIDENCE_BYTES) throw new Error('EVIDENCE_RESPONSE_TOO_LARGE');
  if (!response.body) throw new Error('EVIDENCE_EMPTY_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EVIDENCE_BYTES) throw new Error('EVIDENCE_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const data = new Uint8Array(size);
  let index = 0;
  for (const chunk of chunks) { data.set(chunk, index); index += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(data));
}

/** Only fixed semantic paths. Token pins instance and [from,to) at the API. */
export async function requestEvidence(context: EvidenceContext, tool: EvidenceTool,
                                      args: { dbid?: number; relid?: number; ordering?: string; limit?: number;
                                              max_points?: number } = {}): Promise<unknown> {
  const input = configSchema.parse(context);
  const root = new URL(input.apiUrl);
  if (!['http:', 'https:'].includes(root.protocol) || root.username || root.password
      || root.search || root.hash || root.pathname !== '/') throw new Error('AGENT_API_URL_INVALID');
  const url = new URL(`/api/agent-evidence${tool === 'find_instance' ? '' : '/' + input.instancePk}${PATHS[tool]}`, root);
  if (tool !== 'find_instance') {
    url.searchParams.set('from', input.from);
    url.searchParams.set('to', input.to);
  }
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: 'GET', redirect: 'error',
    headers: { authorization: `Bearer ${input.evidenceToken}`, accept: 'application/json' },
    signal: AbortSignal.timeout(EVIDENCE_TIMEOUT_MS),
  });
  const body = await boundedJson(response);
  if (!response.ok) {
    const code = typeof body === 'object' && body !== null && 'code' in body
      ? String(body.code) : 'http_error';
    throw new EvidenceApiError(response.status, code);
  }
  return body;
}
