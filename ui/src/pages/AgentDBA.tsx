import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiPost, apiPut } from '../api/client';

interface InstanceOption {
  instance_pk: number;
  display_name: string;
  pg_major: number | null;
  is_active: boolean;
}

interface Investigation {
  investigation_id: string;
  question: string;
  investigation_type: 'autovacuum';
  instance_pk: number | null;
  instance_name?: string;
  time_from: string;
  time_to: string;
  status: string;
  model_provider: string | null;
  model_name: string | null;
  created_at: string;
}

interface Improvement {
  improvement_id: number;
  gap_type: 'DATA_NOT_COLLECTED' | 'DATA_INSUFFICIENT' | 'MCP_FUNCTION_MISSING';
  title: string;
  simple_reason: string;
  status: 'review_required' | 'accepted' | 'in_progress' | 'resolved' | 'rejected';
  occurrence_count: number;
  affected_investigations: number;
  affected_instances: number;
  last_detected_at: string;
  latest_investigation_id: string | null;
  requested_text: string | null;
  available_text: string | null;
  missing_text: string | null;
  reason_text: string | null;
}

type ProviderName = 'gemini' | 'openrouter' | 'ollama' | 'openai' | 'anthropic';
interface ProviderConnection {
  provider: ProviderName;
  model_name: string;
  base_url: string;
  is_enabled: boolean;
  has_api_key: boolean;
  data_policy_acknowledged_at: string | null;
  last_test_status: 'success' | 'failed' | null;
}

const providerInfo: Record<ProviderName, { label: string; hint: string; defaultModel: string; free: boolean }> = {
  gemini: { label: 'Gemini API', hint: 'Ücretsiz API katmanı ile başlanabilir.', defaultModel: 'gemini-2.5-flash', free: true },
  openrouter: { label: 'OpenRouter', hint: 'Ücretsiz modeller düşük/değişken limitlidir.', defaultModel: 'openrouter/free', free: true },
  ollama: { label: 'Yerel Ollama', hint: 'Model kendi makinenizde çalışır; veri dışarı çıkmaz.', defaultModel: 'qwen3', free: true },
  openai: { label: 'OpenAI API', hint: 'ChatGPT aboneliğinden ayrı API anahtarı gerekir.', defaultModel: 'gpt-5-mini', free: false },
  anthropic: { label: 'Anthropic API', hint: 'Claude aboneliğinden ayrı API anahtarı gerekir.', defaultModel: 'claude-sonnet-4-5', free: false },
};

const statusLabel: Record<string, string> = {
  needs_clarification: 'Bilgi bekleniyor', queued: 'Sırada', planning: 'Planlanıyor', collecting_evidence: 'Kanıt toplanıyor',
  interpreting: 'Yorumlanıyor', completed: 'Tamamlandı',
  insufficient_evidence: 'Kanıt yetersiz', failed: 'Hata', cancelled: 'İptal edildi',
  timed_out: 'Zaman aşımı', review_required: 'İncelenecek', accepted: 'Kabul edildi',
  in_progress: 'Geliştiriliyor', resolved: 'Çözüldü', rejected: 'Reddedildi',
};

const gapLabel: Record<Improvement['gap_type'], string> = {
  DATA_NOT_COLLECTED: 'Eksik veri',
  DATA_INSUFFICIENT: 'Yetersiz veri',
  MCP_FUNCTION_MISSING: 'Eksik fonksiyon',
};

function dateInputValue(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export default function AgentDBA() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'chat' | 'improvements' | 'providers'>('chat');
  const [instancePk, setInstancePk] = useState('');
  const [question, setQuestion] = useState('Son 24 saatte bu instance\'ta autovacuum problemi var mı?');
  const [from, setFrom] = useState(() => dateInputValue(new Date(Date.now() - 24 * 3600_000)));
  const [to, setTo] = useState(() => dateInputValue(new Date()));
  const [provider, setProvider] = useState<ProviderName>('gemini');
  const [providerModel, setProviderModel] = useState(providerInfo.gemini.defaultModel);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://host.docker.internal:11434');
  const [policyAccepted, setPolicyAccepted] = useState(false);
  const [improvementPage, setImprovementPage] = useState(0);

  const instances = useQuery({
    queryKey: ['agent-instances'],
    queryFn: () => apiGet<InstanceOption[]>('/instances'),
  });
  const investigations = useQuery({
    queryKey: ['agent-investigations'],
    queryFn: () => apiGet<Investigation[]>('/agent/investigations?limit=50'),
    refetchInterval: 5_000,
  });
  const improvements = useQuery({
    queryKey: ['agent-improvements', improvementPage],
    queryFn: () => apiGet<Improvement[]>(`/agent/improvements?limit=50&offset=${improvementPage * 50}`),
    refetchInterval: 15_000,
  });
  const providers = useQuery({
    queryKey: ['agent-providers'],
    queryFn: () => apiGet<ProviderConnection[]>('/agent/providers'),
  });

  const activeInstances = useMemo(
    () => (instances.data ?? []).filter(instance => instance.is_active), [instances.data],
  );

  // Yalnizca doldurulan alanlar gonderilir. Instance ve zaman araligi
  // zorunlu degildir: API tek aktif instance varsa onu secer, birden fazlaysa
  // sorar; aralik verilmezse son 24 saati kullanip bunu konusmaya yazar.
  const createInvestigation = useMutation({
    mutationFn: () => apiPost<Investigation>('/agent/investigations', {
      question,
      investigation_type: 'autovacuum',
      ...(instancePk ? { instance_pk: Number(instancePk) } : {}),
      ...(from && to
        ? { time_from: new Date(from).toISOString(), time_to: new Date(to).toISOString() }
        : {}),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-investigations'] }),
  });

  // Sorulan hedefi cevaplar ve arastirmayi kuyruga alir.
  const clarifyInvestigation = useMutation({
    mutationFn: ({ id, instance }: { id: string; instance: number }) =>
      apiPost(`/agent/investigations/${id}/clarify`, { instance_pk: instance }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-investigations'] }),
  });

  const updateImprovement = useMutation({
    mutationFn: ({ id, status }: { id: number; status: Improvement['status'] }) =>
      apiPatch(`/agent/improvements/${id}/status`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-improvements'] }),
  });
  const cancelInvestigation = useMutation({
    mutationFn: (id: string) => apiPost(`/agent/investigations/${id}/cancel`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agent-investigations'] }),
  });
  const saveProvider = useMutation({
    mutationFn: () => apiPut<ProviderConnection>(`/agent/providers/${provider}`, {
      model_name: providerModel,
      ...(provider === 'ollama' ? { base_url: baseUrl } : {}),
      ...(apiKey ? { api_key: apiKey } : {}),
      is_enabled: true,
      data_policy_acknowledged: provider === 'ollama' || policyAccepted,
    }),
    onSuccess: () => {
      setApiKey('');
      queryClient.invalidateQueries({ queryKey: ['agent-providers'] });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    // Tek zorunlu alan soru. Instance secilmediyse API ya tek aktif olani
    // secer ya da geri sorar; burada engellemiyoruz.
    if (!question.trim()) return;
    createInvestigation.mutate();
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-5">
        <h1 className="text-xl font-bold text-[#1E293B]">AI DBA</h1>
        <p className="text-sm text-[#64748B] mt-1">
          pgstat kanıtlarını sınırlı araçlarla araştırır; PostgreSQL'e veya pgstat DB'ye doğrudan bağlanmaz.
        </p>
      </div>

      <div className="flex gap-1 border-b border-[#E2E8F0] mb-5">
        <button onClick={() => setTab('chat')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'chat' ? 'border-blue-500 text-blue-700' : 'border-transparent text-[#64748B]'}`}>
          Araştırma
        </button>
        <button onClick={() => setTab('improvements')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'improvements' ? 'border-blue-500 text-blue-700' : 'border-transparent text-[#64748B]'}`}>
          AI'ın İstedikleri
        </button>
        <button onClick={() => setTab('providers')}
          className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'providers' ? 'border-blue-500 text-blue-700' : 'border-transparent text-[#64748B]'}`}>
          AI Bağlantısı
        </button>
      </div>

      {tab === 'chat' ? (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-5">
          <form onSubmit={submit} className="bg-white border border-[#E2E8F0] rounded-lg p-5 shadow-sm">
            <h2 className="font-semibold text-[#1E293B] mb-4">Yeni araştırma</h2>
            <label className="block text-xs font-semibold text-[#64748B] mb-1">
              Instance <span className="font-normal text-[#94A3B8]">(opsiyonel)</span>
            </label>
            <select value={instancePk} onChange={e => setInstancePk(e.target.value)}
              className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm mb-4 bg-white">
              <option value="">Seçmeyeyim — gerekirse bana sor</option>
              {activeInstances.map(instance => (
                <option key={instance.instance_pk} value={instance.instance_pk}>
                  {instance.display_name}{instance.pg_major ? ` — PG${instance.pg_major}` : ''}
                </option>
              ))}
            </select>

            <label className="block text-xs font-semibold text-[#64748B] mb-1">Sorunuz</label>
            <textarea value={question} onChange={e => setQuestion(e.target.value)} maxLength={4000} required rows={5}
              className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm resize-y" />

            <div className="grid sm:grid-cols-2 gap-3 mt-4">
              <label className="text-xs font-semibold text-[#64748B]">Başlangıç
                <input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)}
                  className="block w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm mt-1 font-normal" />
              </label>
              <label className="text-xs font-semibold text-[#64748B]">Bitiş
                <input type="datetime-local" value={to} onChange={e => setTo(e.target.value)}
                  className="block w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm mt-1 font-normal" />
              </label>
            </div>
            <p className="mt-2 text-xs text-[#94A3B8]">
              Boş bırakırsanız son 24 saat kullanılır ve bu araştırma notuna yazılır.
            </p>

            {createInvestigation.error &&
              <p className="mt-3 text-sm text-red-600">{createInvestigation.error.message}</p>}
            {createInvestigation.isSuccess &&
              <p className="mt-3 text-sm text-green-700">Araştırma sıraya alındı.</p>}
            <button type="submit" disabled={createInvestigation.isPending || !instancePk}
              className="mt-5 bg-[#2563EB] disabled:bg-[#94A3B8] text-white rounded-md px-4 py-2 text-sm font-medium">
              {createInvestigation.isPending ? 'Başlatılıyor…' : 'AI ile incele'}
            </button>
          </form>

          <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 shadow-sm">
            <h2 className="font-semibold text-[#1E293B] mb-3">Son araştırmalar</h2>
            {investigations.error && <p role="alert" className="text-sm text-red-600">{investigations.error.message}</p>}
            {cancelInvestigation.error && <p role="alert" className="text-sm text-red-600">{cancelInvestigation.error.message}</p>}
            {investigations.isLoading && <p className="text-sm text-[#94A3B8]">Yükleniyor…</p>}
            {investigations.data?.length === 0 && <p className="text-sm text-[#94A3B8]">Henüz araştırma yok.</p>}
            <div className="space-y-3">
              {investigations.data?.map(item => (
                <div key={item.investigation_id} className="border-b border-[#F1F5F9] pb-3 last:border-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-[#334155] line-clamp-2">{item.question}</p>
                    <span className="shrink-0 text-[11px] rounded bg-slate-100 text-slate-600 px-2 py-1">
                      {statusLabel[item.status] ?? item.status}
                    </span>
                  </div>
                  <p className="text-xs text-[#94A3B8] mt-1">
                    {item.instance_pk === null
                      ? 'Instance henüz belirlenmedi'
                      : item.instance_name ?? `#${item.instance_pk}`}
                    {' · '}{new Date(item.created_at).toLocaleString('tr-TR')}
                  </p>

                  {/* Hedef sorulduysa cevabi burada alinir; arastirma o zaman kuyruga girer. */}
                  {item.status === 'needs_clarification' && (
                    <div className="mt-2 rounded-md bg-amber-50 border border-amber-200 p-2">
                      <p className="text-xs text-amber-900 mb-2">
                        Hangi instance için bakayım?
                      </p>
                      <select defaultValue="" disabled={clarifyInvestigation.isPending}
                        onChange={event => {
                          const value = Number(event.target.value);
                          if (value > 0) {
                            clarifyInvestigation.mutate({ id: item.investigation_id, instance: value });
                          }
                        }}
                        className="w-full border border-amber-300 rounded-md px-2 py-1.5 text-xs bg-white">
                        <option value="">Instance seçin…</option>
                        {activeInstances.map(instance => (
                          <option key={instance.instance_pk} value={instance.instance_pk}>
                            {instance.display_name}
                          </option>
                        ))}
                      </select>
                      {clarifyInvestigation.error && (
                        <p className="mt-1 text-xs text-red-600">{clarifyInvestigation.error.message}</p>
                      )}
                    </div>
                  )}
                  {['needs_clarification', 'queued', 'planning', 'collecting_evidence', 'interpreting'].includes(item.status) && (
                    <button type="button" disabled={cancelInvestigation.isPending}
                      onClick={() => cancelInvestigation.mutate(item.investigation_id)}
                      className="text-xs text-red-700 mt-2 disabled:opacity-50">
                      İptal et
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : tab === 'improvements' ? (
        <div>
          <div className="mb-4">
            <h2 className="font-semibold text-[#1E293B]">AI ne istedi, pgstat neden veremedi?</h2>
            <p className="text-sm text-[#64748B] mt-1">Tekrarlanan eksikler aynı kayıtta birleşir; collector otomatik değiştirilmez.</p>
          </div>
          {improvements.isLoading && <p className="text-sm text-[#94A3B8]">Yükleniyor…</p>}
          {improvements.error && <p role="alert" className="text-sm text-red-600">{improvements.error.message}</p>}
          {updateImprovement.error && <p role="alert" className="text-sm text-red-600">{updateImprovement.error.message}</p>}
          {improvements.data?.length === 0 && (
            <div className="bg-white border border-dashed border-[#CBD5E1] rounded-lg p-10 text-center text-sm text-[#64748B]">
              {improvementPage === 0 ? 'AI’ın bildirdiği bir veri veya fonksiyon eksiği yok.' : 'Bu sayfada başka kayıt yok.'}
            </div>
          )}
          <div className="space-y-3">
            {improvements.data?.map(item => (
              <article key={item.improvement_id} className="bg-white border border-[#E2E8F0] rounded-lg p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <span className="text-xs font-semibold text-blue-700">{gapLabel[item.gap_type]}</span>
                    <h3 className="font-semibold text-[#1E293B] mt-1">{item.title}</h3>
                  </div>
                  <select value={item.status} disabled={updateImprovement.isPending}
                    onChange={e => updateImprovement.mutate({ id: item.improvement_id, status: e.target.value as Improvement['status'] })}
                    className="border border-[#CBD5E1] rounded-md px-2 py-1.5 text-xs bg-white">
                    {['review_required', 'accepted', 'in_progress', 'resolved', 'rejected'].map(status =>
                      <option key={status} value={status}>{statusLabel[status]}</option>)}
                  </select>
                </div>
                <div className="mt-4 grid md:grid-cols-[130px_1fr] gap-y-2 text-sm">
                  <span className="text-[#64748B]">AI ne istedi?</span>
                  <span className="text-[#334155] break-words">{item.requested_text ?? 'İstek ayrıntısı kayıtlı değil.'}</span>
                  <span className="text-[#64748B]">Ne vardı?</span>
                  <span className="text-[#334155] break-words">{item.available_text ?? 'Mevcut veri ayrıntısı kayıtlı değil.'}</span>
                  <span className="text-[#64748B]">Ne eksikti?</span>
                  <span className="text-[#334155] break-words">{item.missing_text ?? 'Eksik veri ayrıntısı kayıtlı değil.'}</span>
                  <span className="text-[#64748B]">Neden veremedik?</span>
                  <span className="text-[#334155] break-words">{item.reason_text ?? item.simple_reason}</span>
                </div>
                {item.latest_investigation_id && <p className="text-xs text-[#64748B] mt-2">Son örnek: araştırma #{item.latest_investigation_id}</p>}
                <p className="text-xs text-[#94A3B8] mt-4">
                  {item.affected_investigations} araştırmada · {item.affected_instances} instance · {item.occurrence_count} kez görüldü
                </p>
              </article>
            ))}
          </div>
          <div className="flex items-center gap-3 mt-4 text-sm">
            <button type="button" disabled={improvementPage === 0 || improvements.isFetching}
              onClick={() => setImprovementPage(page => page - 1)} className="disabled:opacity-40">Önceki</button>
            <span>Sayfa {improvementPage + 1}</span>
            <button type="button" disabled={improvements.isFetching || (improvements.data?.length ?? 0) < 50 || improvementPage >= 2000}
              onClick={() => setImprovementPage(page => page + 1)} className="disabled:opacity-40">Sonraki</button>
          </div>
        </div>
      ) : (
        <div className="grid lg:grid-cols-[minmax(0,1fr)_360px] gap-5">
          <form onSubmit={event => { event.preventDefault(); saveProvider.mutate(); }}
            className="bg-white border border-[#E2E8F0] rounded-lg p-5 shadow-sm">
            <h2 className="font-semibold text-[#1E293B]">AI sağlayıcısı bağla</h2>
            <p className="text-sm text-[#64748B] mt-1 mb-5">Anahtar şifreli saklanır ve kaydettikten sonra tekrar gösterilmez.</p>

            <label className="block text-xs font-semibold text-[#64748B] mb-1">Sağlayıcı</label>
            <select value={provider} onChange={event => {
              const next = event.target.value as ProviderName;
              setProvider(next); setProviderModel(providerInfo[next].defaultModel);
              setPolicyAccepted(next === 'ollama'); setApiKey('');
            }} className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm bg-white">
              {(Object.keys(providerInfo) as ProviderName[]).map(name =>
                <option key={name} value={name}>{providerInfo[name].label}{providerInfo[name].free ? ' — ücretsiz seçenek' : ''}</option>)}
            </select>
            <p className="text-xs text-[#64748B] mt-2">{providerInfo[provider].hint}</p>

            <label className="block text-xs font-semibold text-[#64748B] mt-4 mb-1">Model</label>
            <input value={providerModel} onChange={event => setProviderModel(event.target.value)} required maxLength={120}
              className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />

            {provider === 'ollama' ? (
              <>
                <label className="block text-xs font-semibold text-[#64748B] mt-4 mb-1">Yerel Ollama adresi</label>
                <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} required
                  placeholder="http://host.docker.internal:11434"
                  className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
              </>
            ) : (
              <>
                <label className="block text-xs font-semibold text-[#64748B] mt-4 mb-1">API anahtarı</label>
                <input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)}
                  placeholder={providers.data?.some(item => item.provider === provider && item.has_api_key) ? 'Mevcut anahtarı korumak için boş bırakın' : 'API anahtarını girin'}
                  className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                <label className="flex items-start gap-2 mt-4 text-sm text-[#475569]">
                  <input type="checkbox" checked={policyAccepted} onChange={event => setPolicyAccepted(event.target.checked)} className="mt-1" />
                  <span>Bulut sağlayıcısına sınırlı pgstat kanıtı gönderileceğini anlıyorum. Ham query text varsayılan olarak gönderilmez.</span>
                </label>
              </>
            )}

            {saveProvider.error && <p className="text-sm text-red-600 mt-3">{saveProvider.error.message}</p>}
            {saveProvider.isSuccess && <p className="text-sm text-green-700 mt-3">Sağlayıcı kaydedildi.</p>}
            <button type="submit" disabled={saveProvider.isPending || (provider !== 'ollama' && !policyAccepted)}
              className="mt-5 bg-[#2563EB] disabled:bg-[#94A3B8] text-white rounded-md px-4 py-2 text-sm font-medium">
              {saveProvider.isPending ? 'Kaydediliyor…' : 'Bağlantıyı kaydet'}
            </button>
          </form>

          <div className="bg-white border border-[#E2E8F0] rounded-lg p-4 shadow-sm">
            <h2 className="font-semibold text-[#1E293B] mb-3">Bağlı sağlayıcılar</h2>
            {providers.data?.length === 0 && <p className="text-sm text-[#94A3B8]">Henüz sağlayıcı bağlanmadı.</p>}
            <div className="space-y-3">
              {providers.data?.map(item => (
                <div key={item.provider} className="border-b border-[#F1F5F9] pb-3 last:border-0">
                  <div className="flex justify-between gap-2">
                    <span className="text-sm font-medium text-[#334155]">{providerInfo[item.provider].label}</span>
                    <span className="text-xs text-[#64748B]">{!item.is_enabled ? 'Kapalı' : item.last_test_status === 'success' ? 'Bağlantı doğrulandı' : item.last_test_status === 'failed' ? 'Bağlantı testi başarısız' : 'Kayıtlı — henüz test edilmedi'}</span>
                  </div>
                  <p className="text-xs text-[#64748B] mt-1">{item.model_name}</p>
                  <p className="text-xs text-[#94A3B8] mt-1">{item.provider === 'ollama' ? item.base_url : item.has_api_key ? 'API anahtarı kayıtlı' : 'API anahtarı yok'}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
