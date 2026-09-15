// Saglayicinin ANAHTARLA gercekten kullanabilecegi modelleri listeler.
//
// Model adini elle yazdirmak, bugun yasanan MODEL_HTTP_404 sinifi hatanin
// kaynagiydi: ad dogru gorunuyor ama o anahtarin erisimi olmayabiliyor ya da
// model sohbet uretimini hic desteklemiyor. Liste dogrudan saglayicidan
// alinir; boylece gosterilen her secenek o anahtarla kullanilabilir olandir.
//
// Kota BILGISI BURADA YOKTUR. Gemini'nin model ucu yalnizca meta veri
// dondurur; rate limit / kota basit API anahtariyla sorgulanamaz. Uydurma bir
// sayi gostermektense hic gostermemek dogrudur.

import type { Pool } from 'pg';
import { readAgentSecretRef } from '../config/secrets';

const CLOUD_ENDPOINTS: Record<string, string> = {
  gemini: 'https://generativelanguage.googleapis.com',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

/** Model listeleri uzun olabiliyor (Gemini'de ~50 kayit olculdu). */
const MAX_CATALOG_BYTES = 512 * 1024;
const CATALOG_TIMEOUT_MS = 15_000;
/** Cevap boyutunu sinirlamak icin donulecek en fazla model. */
const MAX_MODELS = 200;

export interface ProviderModel {
  id: string;
  label: string;
  /** Kullaniciya yardimci kisa not; yoksa null. */
  note: string | null;
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('RESPONSE_EMPTY');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CATALOG_BYTES) throw new Error('RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const buffer = new Uint8Array(size);
  let index = 0;
  for (const chunk of chunks) { buffer.set(chunk, index); index += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(buffer)) as Record<string, unknown>; }
  catch { throw new Error('RESPONSE_INVALID_JSON'); }
}

/**
 * Kayitli baglantiyi dogrular ve saglayicidan model listesini ceker.
 *
 * Dogrulama testProviderConnection ile ayni: bulut saglayicilarda base_url
 * sabittir, yerel Ollama yalnizca izinli hostlara gidebilir. Istemciden URL
 * ya da model adi alinmaz.
 */
export async function listProviderModels(database: Pool, provider: string): Promise<ProviderModel[]> {
  const read = await database.query(
    `select provider, base_url, secret_ref, is_enabled
       from agent.provider_connection where provider = $1`, [provider]);
  const row = read.rows[0];
  if (!row) throw new Error('PROVIDER_NOT_CONFIGURED');
  if (provider !== 'ollama' && !row.secret_ref) throw new Error('PROVIDER_NOT_READY');

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

  const apiKey = provider === 'ollama' ? null : readAgentSecretRef(row.secret_ref);
  const headers: Record<string, string> = { accept: 'application/json' };

  if (provider === 'gemini') {
    url.pathname = '/v1beta/models';
    url.searchParams.set('pageSize', '200');
    headers['x-goog-api-key'] = apiKey!;
  } else if (provider === 'anthropic') {
    url.pathname = '/v1/models';
    headers['x-api-key'] = apiKey!;
    headers['anthropic-version'] = '2023-06-01';
  } else if (provider === 'ollama') {
    url.pathname = '/api/tags';
  } else {
    // openai ve openrouter: base_url zaten /v1 ile bitiyor.
    url.pathname = `${url.pathname.replace(/\/$/, '')}/models`;
    headers.authorization = `Bearer ${apiKey}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET', headers, redirect: 'error',
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
  } catch { throw new Error('PROVIDER_UNREACHABLE'); }

  const data = await boundedJson(response);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new Error('PROVIDER_AUTH_FAILED');
    if (response.status === 429) throw new Error('PROVIDER_RATE_LIMITED');
    throw new Error(`PROVIDER_HTTP_${response.status}`);
  }
  return normalize(provider, data).slice(0, MAX_MODELS);
}

/**
 * Saglayici bicimlerini tek listeye indirger ve KULLANILAMAYACAK modelleri
 * ayiklar. Gemini'nin listesinde embedding, goruntu, video ve ses modelleri
 * de var; bunlar sohbet uretimi yapamaz ve secenek olarak gosterilirse
 * kullaniciyi calismayan bir yapilandirmaya goturur.
 */
function normalize(provider: string, data: Record<string, unknown>): ProviderModel[] {
  if (provider === 'gemini') {
    const models = Array.isArray(data.models) ? data.models : [];
    return models.flatMap(entry => {
      const item = entry as {
        name?: unknown; displayName?: unknown; description?: unknown;
        supportedGenerationMethods?: unknown;
      };
      const methods = Array.isArray(item.supportedGenerationMethods)
        ? item.supportedGenerationMethods.map(String) : [];
      if (!methods.includes('generateContent')) return [];
      const full = typeof item.name === 'string' ? item.name : '';
      const id = full.replace(/^models\//, '');
      if (!id) return [];
      return [{
        id,
        label: typeof item.displayName === 'string' && item.displayName.trim() !== ''
          ? `${item.displayName} (${id})` : id,
        note: typeof item.description === 'string' ? shorten(item.description) : null,
      }];
    });
  }

  if (provider === 'anthropic' || provider === 'openrouter' || provider === 'openai') {
    const list = Array.isArray(data.data) ? data.data : [];
    return list.flatMap(entry => {
      const item = entry as { id?: unknown; display_name?: unknown; name?: unknown };
      const id = typeof item.id === 'string' ? item.id : '';
      if (!id) return [];
      const display = typeof item.display_name === 'string' ? item.display_name
        : typeof item.name === 'string' ? item.name : '';
      return [{ id, label: display && display !== id ? `${display} (${id})` : id, note: null }];
    });
  }

  // ollama
  const models = Array.isArray(data.models) ? data.models : [];
  return models.flatMap(entry => {
    const item = entry as { name?: unknown; model?: unknown };
    const id = typeof item.name === 'string' ? item.name
      : typeof item.model === 'string' ? item.model : '';
    return id ? [{ id, label: id, note: null }] : [];
  });
}

function shorten(text: string): string | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === '') return null;
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean;
}
