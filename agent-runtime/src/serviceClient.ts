import { z } from 'zod';
import type { ProviderConfig } from './provider.js';

const responseLimit = 256 * 1024;
export class ServiceApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Service API ${status}: ${code}`); }
}

export class AgentServiceClient {
  constructor(readonly apiUrl: string, private readonly serviceSecret: string, readonly workerId: string) {
    const url = new URL(apiUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash
        || url.username || url.password || serviceSecret.length < 32
        || !/^[a-zA-Z0-9_-]{8,100}$/.test(workerId)) throw new Error('AGENT_SERVICE_CONFIG_INVALID');
  }

  private async call(path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal) {
    const url = new URL(`/api/agent-service${path}`, this.apiUrl);
    const response = await fetch(url, {
      method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${this.serviceSecret}`, accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 204) return null;
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > responseLimit) throw new Error('AGENT_SERVICE_RESPONSE_TOO_LARGE');
    const text = await response.text();
    if (Buffer.byteLength(text) > responseLimit) throw new Error('AGENT_SERVICE_RESPONSE_TOO_LARGE');
    let decoded: unknown;
    try { decoded = JSON.parse(text); } catch { throw new Error('AGENT_SERVICE_RESPONSE_INVALID'); }
    if (!response.ok) {
      const code = decoded && typeof decoded === 'object' && 'error' in decoded
        ? String(decoded.error) : 'HTTP_ERROR';
      throw new ServiceApiError(response.status, code);
    }
    return decoded;
  }

  async claim() {
    return this.call('/claim', 'POST', { worker_id: this.workerId }) as Promise<{
      investigation: { investigation_id: string; question: string; instance_pk: string;
        dbid: number | null; time_from: string; time_to: string; status: string };
      evidence_token: string;
    } | null>;
  }

  async provider(id: string): Promise<ProviderConfig> {
    const response = await this.call(`/investigations/${id}/provider?worker_id=${encodeURIComponent(this.workerId)}`, 'GET');
    const row = z.object({ provider: z.enum(['gemini', 'openrouter', 'ollama', 'openai', 'anthropic']),
      model: z.string(), base_url: z.string(), api_key: z.string().nullable() }).parse(response);
    return { provider: row.provider, model: row.model, baseUrl: row.base_url, apiKey: row.api_key };
  }

  async advance(id: string, expected: 'planning' | 'collecting_evidence',
                next: 'collecting_evidence' | 'interpreting') {
    return this.call(`/investigations/${id}/advance`, 'POST',
      { worker_id: this.workerId, expected, next });
  }

  async heartbeat(id: string) {
    return this.call(`/investigations/${id}/heartbeat`, 'POST', { worker_id: this.workerId });
  }

  async evidence(id: string, toolName: string, envelope: unknown, durationMs: number) {
    return this.call(`/investigations/${id}/evidence`, 'POST',
      { worker_id: this.workerId, tool_name: toolName, envelope, duration_ms: durationMs }) as
      Promise<{ evidence_id: string; tool_call_id: string }>;
  }

  async toolFailure(id: string, toolName: string, code: string, durationMs: number) {
    return this.call(`/investigations/${id}/tool-failure`, 'POST',
      { worker_id: this.workerId, tool_name: toolName, code, duration_ms: durationMs });
  }

  async complete(id: string, result: unknown, inputTokens: number | null, outputTokens: number | null) {
    return this.call(`/investigations/${id}/complete`, 'POST',
      { worker_id: this.workerId, result, input_tokens: inputTokens, output_tokens: outputTokens });
  }

  async missingCapabilities(id: string, capabilities: ('query_performance_evidence' | 'compare_periods')[]) {
    return this.call(`/investigations/${id}/missing-capabilities`, 'POST',
      { worker_id: this.workerId, capabilities });
  }

  async fail(id: string, code: string, detail: string) {
    return this.call(`/investigations/${id}/fail`, 'POST',
      { worker_id: this.workerId, code, detail });
  }

  async reclaim() { return this.call('/reclaim-stale', 'POST'); }
}
