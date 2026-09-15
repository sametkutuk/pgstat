import { z } from 'zod';

export const providerNameSchema = z.enum(['gemini', 'openrouter', 'ollama', 'openai', 'anthropic']);
export type ProviderName = z.infer<typeof providerNameSchema>;
export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  baseUrl: string;
  apiKey: string | null;
}

const CLOUD_URLS: Record<Exclude<ProviderName, 'ollama'>, string> = {
  gemini: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

export const MODEL_RESPONSE_TIMEOUT_MS = 30_000;
export const MAX_MODEL_RESPONSE_BYTES = 256 * 1024;
export const MAX_MODEL_OUTPUT_TOKENS = 1024;

export function validateProvider(config: ProviderConfig): URL {
  const provider = providerNameSchema.parse(config.provider);
  if (!config.model || config.model.length > 120 || !/^[a-zA-Z0-9][a-zA-Z0-9._:\/-]*$/.test(config.model)) {
    throw new Error('MODEL_NAME_INVALID');
  }
  if (provider !== 'ollama') {
    if (config.baseUrl !== CLOUD_URLS[provider] || !config.apiKey) throw new Error('CLOUD_PROVIDER_CONFIG_INVALID');
    return new URL(config.baseUrl);
  }
  const url = new URL(config.baseUrl);
  const allowed = new Set((process.env.PGSTAT_AI_LOCAL_HOSTS ?? 'ollama,host.docker.internal,localhost,127.0.0.1')
    .split(',').map(host => host.trim().toLowerCase()).filter(Boolean));
  if (!['http:', 'https:'].includes(url.protocol) || !url.port || url.pathname !== '/' || url.search || url.hash
      || url.username || url.password || !allowed.has(url.hostname.toLowerCase())) throw new Error('OLLAMA_URL_INVALID');
  return url;
}

export class ModelRequestError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number | null = null,
    /** Saglayicinin kendi hata metni — redakte ve kirpilmis. */
    readonly providerDetail: string | null = null,
  ) {
    super(providerDetail ? `${code}: ${providerDetail}` : code);
  }
}

/** Saglayici hata metninin kullaniciya gosterilecek en fazla uzunlugu. */
const MAX_PROVIDER_DETAIL = 400;

/**
 * Saglayicinin hata gövdesinden okunabilir tek bir cumle cikarir.
 *
 * Kod yalnizca "MODEL_HTTP_404" yazdiginda nedeni kor tahminle aramak
 * gerekiyordu; gercek sebep her zaman govdede yaziyor. API anahtari bu metne
 * sizabilecegi icin once redakte edilir.
 */
export function describeProviderError(data: unknown, apiKey: string | null): string | null {
  const asError = (data as { error?: { message?: unknown } } | undefined)?.error;
  const raw = typeof asError?.message === 'string' && asError.message.trim() !== ''
    ? asError.message
    : (() => { try { return JSON.stringify(data); } catch { return null; } })();
  if (!raw) return null;

  let text = raw;
  if (apiKey && apiKey.length >= 8) text = text.split(apiKey).join('[REDACTED]');
  // Anahtar bicimleri metinde ayrica gecebilir.
  text = text.replace(/\b(AIza[0-9A-Za-z_-]{10,}|sk-[0-9A-Za-z_-]{10,}|AQ\.[0-9A-Za-z_-]{10,})/g, '[REDACTED]');
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > MAX_PROVIDER_DETAIL ? `${text.slice(0, MAX_PROVIDER_DETAIL)}…` : text;
}

async function boundedResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new ModelRequestError('MODEL_EMPTY_RESPONSE', response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_MODEL_RESPONSE_BYTES) throw new ModelRequestError('MODEL_RESPONSE_TOO_LARGE', response.status);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const buffer = new Uint8Array(size);
  let index = 0;
  for (const chunk of chunks) { buffer.set(chunk, index); index += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(buffer)); }
  catch { throw new ModelRequestError('MODEL_RESPONSE_INVALID_JSON', response.status); }
}

/** Raw provider request: caller validates the returned JSON against a product schema. */
export async function requestModel(config: ProviderConfig, system: string, prompt: string,
                                   signal?: AbortSignal): Promise<{ text: string; inputTokens: number | null;
                                     outputTokens: number | null }> {
  const root = validateProvider(config);
  if (prompt.length > 40_000 || system.length > 8_000) throw new ModelRequestError('MODEL_PROMPT_TOO_LARGE');
  const url = new URL(root);
  let body: unknown;
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
  if (config.provider === 'gemini') {
    url.pathname = `/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;
    headers['x-goog-api-key'] = config.apiKey!;
    body = { systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        maxOutputTokens: MAX_MODEL_OUTPUT_TOKENS,
        // Gemini 2.5'te dusunme varsayilan olarak aciktir ve maxOutputTokens
        // butcesinden harcanir (olculdu: 2 tokenlik "Pong" cevabinda
        // thoughtsTokenCount 32). Buyuk kanit promptunda butce dusunmeye
        // gidip cevap bos ya da kirpik donebilir. Semaya bagli JSON
        // uretiminde dusunmeye ihtiyac yok; butce cevaba ayriliyor.
        thinkingConfig: { thinkingBudget: 0 },
      } };
  } else if (config.provider === 'anthropic') {
    url.pathname = '/v1/messages';
    headers['x-api-key'] = config.apiKey!;
    headers['anthropic-version'] = '2023-06-01';
    body = { model: config.model, max_tokens: MAX_MODEL_OUTPUT_TOKENS, system,
      messages: [{ role: 'user', content: prompt }] };
  } else if (config.provider === 'ollama') {
    url.pathname = '/api/chat';
    body = { model: config.model, stream: false, format: 'json', think: false,
      options: { num_predict: MAX_MODEL_OUTPUT_TOKENS },
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
  } else {
    url.pathname = `${root.pathname.replace(/\/$/, '')}/chat/completions`;
    headers.authorization = `Bearer ${config.apiKey}`;
    body = { model: config.model, max_completion_tokens: MAX_MODEL_OUTPUT_TOKENS,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] };
  }
  const timeout = AbortSignal.timeout(MODEL_RESPONSE_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', redirect: 'error', headers,
      body: JSON.stringify(body), signal: combined });
  } catch (error) {
    if (combined.aborted) throw new ModelRequestError('MODEL_TIMEOUT_OR_CANCELLED');
    throw new ModelRequestError('MODEL_NETWORK_ERROR');
  }
  const data = await boundedResponse(response);
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'MODEL_AUTH_FAILED'
      : response.status === 429 ? 'MODEL_RATE_LIMITED' : `MODEL_HTTP_${response.status}`;
    throw new ModelRequestError(code, response.status, describeProviderError(data, config.apiKey));
  }
  const record = z.record(z.string(), z.unknown()).parse(data);
  let text: unknown;
  let inputTokens: unknown;
  let outputTokens: unknown;
  if (config.provider === 'gemini') {
    text = (record.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined)?.[0]?.content?.parts?.[0]?.text;
    inputTokens = (record.usageMetadata as { promptTokenCount?: number } | undefined)?.promptTokenCount;
    outputTokens = (record.usageMetadata as { candidatesTokenCount?: number } | undefined)?.candidatesTokenCount;
  } else if (config.provider === 'anthropic') {
    text = (record.content as { type?: string; text?: string }[] | undefined)?.find(x => x.type === 'text')?.text;
    inputTokens = (record.usage as { input_tokens?: number } | undefined)?.input_tokens;
    outputTokens = (record.usage as { output_tokens?: number } | undefined)?.output_tokens;
  } else if (config.provider === 'ollama') {
    text = (record.message as { content?: string } | undefined)?.content;
    inputTokens = record.prompt_eval_count;
    outputTokens = record.eval_count;
  } else {
    text = (record.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content;
    inputTokens = (record.usage as { prompt_tokens?: number } | undefined)?.prompt_tokens;
    outputTokens = (record.usage as { completion_tokens?: number } | undefined)?.completion_tokens;
  }
  if (typeof text !== 'string' || !text.trim() || text.length > 20_000) {
    throw new ModelRequestError('MODEL_TEXT_MISSING_OR_TOO_LARGE');
  }
  const tokenCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { text, inputTokens: tokenCount(inputTokens), outputTokens: tokenCount(outputTokens) };
}
