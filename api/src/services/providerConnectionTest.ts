import type { Pool } from 'pg';
import { readAgentSecretRef } from '../config/secrets';

const CLOUD_ENDPOINTS: Record<string, string> = {
  gemini: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

async function boundedProviderBody(response: Response): Promise<Record<string, unknown>> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > 32768) throw new Error('RESPONSE_TOO_LARGE');
  if (!response.body) throw new Error('RESPONSE_EMPTY');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) throw new Error('RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const buffer = new Uint8Array(size);
  let index = 0;
  for (const chunk of chunks) { buffer.set(chunk, index); index += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(buffer)) as Record<string, unknown>;
}

/** Sends no pgstat data. Success proves endpoint+credential+model reachability only. */
export async function testProviderConnection(database: Pool, provider: string) {
  const read = await database.query(
    `select connection_id, provider, model_name, base_url, secret_ref,
            is_enabled, data_policy_acknowledged_at, updated_at::text as updated_at_key
     from agent.provider_connection where provider = $1`, [provider]);
  const row = read.rows[0];
  if (!row || !row.is_enabled) throw new Error('PROVIDER_NOT_ENABLED');
  if (provider !== 'ollama' && (!row.secret_ref || !row.data_policy_acknowledged_at)) {
    throw new Error('PROVIDER_NOT_READY');
  }
  const cloud = CLOUD_ENDPOINTS[provider];
  if (cloud && row.base_url !== cloud) throw new Error('PROVIDER_URL_INVALID');
  const url = new URL(row.base_url);
  if (provider === 'ollama') {
    const hosts = new Set((process.env.PGSTAT_AI_LOCAL_HOSTS
      ?? 'ollama,host.docker.internal,localhost,127.0.0.1')
      .split(',').map(item => item.trim().toLowerCase()).filter(Boolean));
    if (!hosts.has(url.hostname.toLowerCase()) || !url.port || !['http:', 'https:'].includes(url.protocol)
        || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
      throw new Error('PROVIDER_URL_INVALID');
    }
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  const prompt = 'Reply with the single word READY.';
  let body: unknown;
  if (provider === 'gemini') {
    url.pathname = `/v1beta/models/${encodeURIComponent(row.model_name)}:generateContent`;
    headers['x-goog-api-key'] = readAgentSecretRef(row.secret_ref);
    body = { contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 32 } };
  } else if (provider === 'anthropic') {
    url.pathname = '/v1/messages';
    headers['x-api-key'] = readAgentSecretRef(row.secret_ref);
    headers['anthropic-version'] = '2023-06-01';
    body = { model: row.model_name, max_tokens: 32,
      messages: [{ role: 'user', content: prompt }] };
  } else if (provider === 'ollama') {
    url.pathname = '/api/chat';
    body = { model: row.model_name, stream: false, think: false,
      options: { num_predict: 32 }, messages: [{ role: 'user', content: prompt }] };
  } else {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/chat/completions`;
    headers.authorization = `Bearer ${readAgentSecretRef(row.secret_ref)}`;
    body = { model: row.model_name, max_completion_tokens: 32,
      messages: [{ role: 'user', content: prompt }] };
  }
  let status: 'success' | 'failed' = 'failed';
  let errorCode: string | null = null;
  try {
    const response = await fetch(url, { method: 'POST', redirect: 'error', headers,
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      errorCode = response.status === 401 || response.status === 403 ? 'AUTH_FAILED'
        : response.status === 429 ? 'RATE_LIMITED' : `HTTP_${response.status}`;
    } else {
      const value = await boundedProviderBody(response);
      let output: unknown;
      if (provider === 'gemini') output = (value.candidates as { content?: { parts?: { text?: string }[] } }[])?.[0]?.content?.parts?.[0]?.text;
      else if (provider === 'anthropic') output = (value.content as { type?: string; text?: string }[])?.find(item => item.type === 'text')?.text;
      else if (provider === 'ollama') output = (value.message as { content?: string })?.content;
      else output = (value.choices as { message?: { content?: string } }[])?.[0]?.message?.content;
      status = typeof output === 'string' && output.trim().length > 0 ? 'success' : 'failed';
      if (status === 'failed') errorCode = 'MODEL_TEXT_MISSING';
    }
  } catch (error) {
    errorCode = error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT'
      : error instanceof Error && error.message === 'RESPONSE_TOO_LARGE' ? 'RESPONSE_TOO_LARGE'
        : 'NETWORK_OR_RESPONSE_ERROR';
  }
  // A connection changed during this call must not inherit the stale test result.
  const saved = await database.query(
    `update agent.provider_connection set last_tested_at = now(), last_test_status = $3,
        last_test_error_code = $4, updated_at = now()
     where connection_id = $1 and updated_at = $2::timestamptz
     returning provider, model_name, is_enabled, last_tested_at, last_test_status,
               last_test_error_code`, [row.connection_id, row.updated_at_key, status, errorCode]);
  if (!saved.rowCount) return { status: 'superseded' as const };
  return { status, error_code: errorCode, provider: row.provider, model_name: row.model_name };
}
