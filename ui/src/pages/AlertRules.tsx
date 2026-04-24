import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, apiDelete, apiPatch } from '../api/client';
import { useToast } from '../components/common/Toast';
import Badge from '../components/common/Badge';

// =========================================================================
// Tipler
// =========================================================================

interface AlertRule {
  rule_id: number;
  rule_name: string;
  description: string | null;
  metric_type: string;
  metric_name: string;
  scope: string;
  instance_pk: number | null;
  instance_name: string | null;
  service_group: string | null;
  condition_operator: string;
  warning_threshold: number | null;
  critical_threshold: number | null;
  evaluation_window_minutes: number;
  aggregation: string;
  is_enabled: boolean;
  cooldown_minutes: number;
  auto_resolve: boolean;
  created_by: string | null;
  open_alert_count: number;
  last_evaluated_at: string | null;
  last_value: number | null;
  current_severity: string | null;
}

interface Instance {
  instance_pk: number;
  display_name: string;
}

const METRIC_TYPES: Record<string, { label: string; metrics: Record<string, string> }> = {
  cluster_metric: {
    label: 'Cluster Sağlığı',
    metrics: {
      cache_hit_ratio: 'Cache Hit Ratio (%)',
      wal_bytes: 'WAL Üretimi (byte)',
      checkpoint_write_time: 'Checkpoint Yazma Süresi (ms)',
      buffers_checkpoint: 'Checkpoint Buffer Yazımı',
      buffers_clean: 'Bgwriter Buffer Temizleme',
    },
  },
  activity_metric: {
    label: 'Bağlantı / Aktivite',
    metrics: {
      active_count: 'Aktif Bağlantı Sayısı',
      idle_in_transaction_count: 'Idle in Transaction Sayısı',
      waiting_count: 'Kilit Bekleyen Sayısı',
    },
  },
  replication_metric: {
    label: 'Replikasyon',
    metrics: {
      replay_lag_bytes: 'Replay Gecikme (byte)',
      replay_lag_seconds: 'Replay Gecikme (saniye)',
    },
  },
  database_metric: {
    label: 'Veritabanı',
    metrics: {
      deadlocks: 'Deadlock Sayısı',
      temp_files: 'Geçici Dosya Sayısı',
      rollback_ratio: 'Rollback Oranı (%)',
      blk_read_time: 'Disk Okuma Süresi (ms)',
      blk_write_time: 'Disk Yazma Süresi (ms)',
    },
  },
  statement_metric: {
    label: 'Sorgu (pg_stat_statements)',
    metrics: {
      avg_exec_time_ms: 'Ortalama Çalışma Süresi (ms)',
      temp_blks_written: 'Geçici Blok Yazımı',
      calls: 'Çağrı Sayısı',
    },
  },
  table_metric: {
    label: 'Tablo',
    metrics: {
      dead_tuple_ratio: 'Dead Tuple Oranı (%)',
      seq_scan: 'Sequential Scan Sayısı',
      n_tup_ins: 'INSERT Sayısı',
    },
  },
};

const OPERATORS = ['>', '<', '>=', '<=', '='];
const AGGREGATIONS: Record<string, string> = {
  avg: 'Ortalama',
  sum: 'Toplam',
  max: 'Maksimum',
  min: 'Minimum',
  last: 'Son Değer',
  count: 'Sayı',
};
const WINDOW_OPTIONS = [1, 5, 10, 15, 30, 60, 120];
const COOLDOWN_OPTIONS = [0, 5, 10, 15, 30, 60, 120];

const emptyForm = {
  rule_name: '',
  description: '',
  metric_type: 'cluster_metric',
  metric_name: 'cache_hit_ratio',
  scope: 'all_instances',
  instance_pk: null as number | null,
  service_group: '',
  condition_operator: '>',
  warning_threshold: '' as string | number,
  critical_threshold: '' as string | number,
  evaluation_window_minutes: 5,
  aggregation: 'avg',
  is_enabled: true,
  cooldown_minutes: 15,
  auto_resolve: true,
};

// =========================================================================
// Ana Sayfa
// =========================================================================

export default function AlertRules() {
  const [tab, setTab] = useState<'list' | 'templates'>('list');
  const [showForm, setShowForm] = useState(false);
  const [editRule, setEditRule] = useState<AlertRule | null>(null);
  const [templateForm, setTemplateForm] = useState<AlertRule | null>(null);

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold">Alert Kuralları</h1>
        <button
          onClick={() => { setEditRule(null); setShowForm(true); }}
          className="px-4 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB] transition-colors"
        >
          + Kural Ekle
        </button>
      </div>

      <div className="flex gap-1 mb-4 border-b border-[#E2E8F0]">
        {[{ k: 'list', l: 'Kurallar' }, { k: 'templates', l: 'Hazır Template\'ler' }].map((t) => (
          <button key={t.k} onClick={() => setTab(t.k as any)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t.k ? 'border-[#3B82F6] text-[#3B82F6]' : 'border-transparent text-[#64748B] hover:text-[#1E293B]'}`}>
            {t.l}
          </button>
        ))}
      </div>

      {tab === 'list' && (
        <RuleList
          onEdit={(rule) => { setEditRule(rule); setShowForm(true); }}
        />
      )}
      {tab === 'templates' && (
        <TemplateGallery onActivate={(tpl) => setTemplateForm(tpl)} />
      )}

      {showForm && (
        <RuleFormModal
          rule={editRule}
          onClose={() => { setShowForm(false); setEditRule(null); }}
        />
      )}
      {templateForm && (
        <FromTemplateModal
          template={templateForm}
          onClose={() => setTemplateForm(null)}
        />
      )}
    </div>
  );
}

// =========================================================================
// Kural Listesi
// =========================================================================

function RuleList({ onEdit }: { onEdit: (r: AlertRule) => void }) {
  const qc = useQueryClient();
  const { addToast } = useToast();

  const { data: rules = [], isLoading } = useQuery<AlertRule[]>({
    queryKey: ['alert-rules'],
    queryFn: () => apiGet('/alert-rules'),
  });

  const toggleMut = useMutation({
    mutationFn: (id: number) => apiPatch(`/alert-rules/${id}/toggle`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }),
    onError: () => addToast('Toggle başarısız', 'error'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiDelete(`/alert-rules/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alert-rules'] }); addToast('Kural silindi', 'success'); },
    onError: () => addToast('Silme başarısız', 'error'),
  });

  if (isLoading) return <div className="text-[#64748B] text-sm">Yükleniyor...</div>;
  if (rules.length === 0) return (
    <div className="text-center py-12 text-[#64748B] text-sm">
      Henüz kural yok. "Hazır Template'ler" sekmesinden başlayabilirsiniz.
    </div>
  );

  return (
    <div className="space-y-2">
      {rules.map((rule) => (
        <div key={rule.rule_id} className="bg-white border border-[#E2E8F0] rounded-lg p-4 flex items-center gap-4">
          {/* Toggle */}
          <button
            onClick={() => toggleMut.mutate(rule.rule_id)}
            className={`w-10 h-6 rounded-full transition-colors flex-shrink-0 ${rule.is_enabled ? 'bg-[#22C55E]' : 'bg-[#CBD5E1]'}`}
            title={rule.is_enabled ? 'Pasif yap' : 'Aktif yap'}
          >
            <span className={`block w-4 h-4 rounded-full bg-white mx-1 transition-transform ${rule.is_enabled ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>

          {/* Kural adı + metrik */}
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm text-[#1E293B] truncate">{rule.rule_name}</div>
            <div className="text-xs text-[#64748B] mt-0.5">
              {METRIC_TYPES[rule.metric_type]?.label || rule.metric_type} › {rule.metric_name}
              {' · '}
              {rule.scope === 'all_instances' ? 'Tüm Instance\'lar' :
               rule.scope === 'specific_instance' ? (rule.instance_name || `#${rule.instance_pk}`) :
               `Grup: ${rule.service_group}`}
            </div>
          </div>

          {/* Eşikler */}
          <div className="text-xs text-[#64748B] text-right flex-shrink-0 hidden md:block">
            {rule.warning_threshold != null && (
              <span className="inline-block bg-[#FEF3C7] text-[#D97706] px-2 py-0.5 rounded mr-1">
                ⚠ {rule.condition_operator} {rule.warning_threshold}
              </span>
            )}
            {rule.critical_threshold != null && (
              <span className="inline-block bg-[#FEE2E2] text-[#DC2626] px-2 py-0.5 rounded">
                ✕ {rule.condition_operator} {rule.critical_threshold}
              </span>
            )}
          </div>

          {/* Pencere + Aggregation */}
          <div className="text-xs text-[#94A3B8] flex-shrink-0 hidden lg:block">
            Son {rule.evaluation_window_minutes}dk {AGGREGATIONS[rule.aggregation]}
          </div>

          {/* Açık alert */}
          {rule.open_alert_count > 0 && (
            <span className="bg-[#FEE2E2] text-[#DC2626] text-xs px-2 py-0.5 rounded-full flex-shrink-0">
              {rule.open_alert_count} alert
            </span>
          )}

          {/* Son değer */}
          {rule.last_value != null && (
            <div className="text-xs flex-shrink-0 hidden xl:block">
              <span className={`px-2 py-0.5 rounded ${
                rule.current_severity === 'critical' ? 'bg-[#FEE2E2] text-[#DC2626]' :
                rule.current_severity === 'warning' ? 'bg-[#FEF3C7] text-[#D97706]' :
                'bg-[#F0FDF4] text-[#16A34A]'
              }`}>
                {Number(rule.last_value).toFixed(2)}
              </span>
            </div>
          )}

          {/* Aksiyon butonları */}
          <div className="flex gap-1 flex-shrink-0">
            <button onClick={() => onEdit(rule)}
              className="px-3 py-1 text-xs bg-[#F1F5F9] text-[#475569] rounded hover:bg-[#E2E8F0] transition-colors">
              Düzenle
            </button>
            <button onClick={() => {
              if (confirm(`"${rule.rule_name}" kuralını silmek istiyor musunuz?`))
                deleteMut.mutate(rule.rule_id);
            }}
              className="px-3 py-1 text-xs bg-[#FEE2E2] text-[#DC2626] rounded hover:bg-[#FECACA] transition-colors">
              Sil
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// =========================================================================
// Template Galerisi
// =========================================================================

function TemplateGallery({ onActivate }: { onActivate: (t: AlertRule) => void }) {
  const { data: templates = [], isLoading } = useQuery<AlertRule[]>({
    queryKey: ['alert-rule-templates'],
    queryFn: () => apiGet('/alert-rules/templates'),
  });

  if (isLoading) return <div className="text-[#64748B] text-sm">Yükleniyor...</div>;

  const grouped: Record<string, AlertRule[]> = {};
  for (const t of templates) {
    const g = METRIC_TYPES[t.metric_type]?.label || t.metric_type;
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(t);
  }

  return (
    <div className="space-y-6">
      {Object.entries(grouped).map(([group, items]) => (
        <div key={group}>
          <h2 className="text-sm font-semibold text-[#475569] mb-3">{group}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {items.map((tpl) => (
              <div key={tpl.rule_id} className="bg-white border border-[#E2E8F0] rounded-lg p-4 flex flex-col gap-2">
                <div className="font-medium text-sm text-[#1E293B]">{tpl.rule_name}</div>
                {tpl.description && (
                  <div className="text-xs text-[#64748B]">{tpl.description}</div>
                )}
                <div className="flex flex-wrap gap-1 mt-1">
                  {tpl.warning_threshold != null && (
                    <span className="text-xs bg-[#FEF3C7] text-[#D97706] px-2 py-0.5 rounded">
                      Uyarı: {tpl.condition_operator} {tpl.warning_threshold}
                    </span>
                  )}
                  {tpl.critical_threshold != null && (
                    <span className="text-xs bg-[#FEE2E2] text-[#DC2626] px-2 py-0.5 rounded">
                      Kritik: {tpl.condition_operator} {tpl.critical_threshold}
                    </span>
                  )}
                  <span className="text-xs bg-[#F1F5F9] text-[#475569] px-2 py-0.5 rounded">
                    Son {tpl.evaluation_window_minutes}dk {AGGREGATIONS[tpl.aggregation]}
                  </span>
                </div>
                <button
                  onClick={() => onActivate(tpl)}
                  className="mt-1 w-full py-1.5 text-xs bg-[#3B82F6] text-white rounded hover:bg-[#2563EB] transition-colors"
                >
                  Aktifleştir
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// =========================================================================
// Kural Formu Modal (Oluştur / Düzenle)
// =========================================================================

function RuleFormModal({ rule, onClose }: { rule: AlertRule | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useToast();
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(() =>
    rule ? {
      rule_name: rule.rule_name,
      description: rule.description || '',
      metric_type: rule.metric_type,
      metric_name: rule.metric_name,
      scope: rule.scope,
      instance_pk: rule.instance_pk,
      service_group: rule.service_group || '',
      condition_operator: rule.condition_operator,
      warning_threshold: rule.warning_threshold ?? '' as string | number,
      critical_threshold: rule.critical_threshold ?? '' as string | number,
      evaluation_window_minutes: rule.evaluation_window_minutes,
      aggregation: rule.aggregation,
      is_enabled: rule.is_enabled,
      cooldown_minutes: rule.cooldown_minutes,
      auto_resolve: rule.auto_resolve,
    } : { ...emptyForm }
  );

  const { data: instances = [] } = useQuery<Instance[]>({
    queryKey: ['instances-list'],
    queryFn: () => apiGet<any[]>('/instances').then(r => r.map((i: any) => ({ instance_pk: i.instance_pk, display_name: i.display_name }))),
  });

  const saveMut = useMutation({
    mutationFn: (body: any) =>
      rule ? apiPut(`/alert-rules/${rule.rule_id}`, body) : apiPost('/alert-rules', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-rules'] });
      addToast(rule ? 'Kural güncellendi' : 'Kural oluşturuldu', 'success');
      onClose();
    },
    onError: (e: any) => addToast(e.message || 'Hata oluştu', 'error'),
  });

  const handleSave = () => {
    const body = {
      ...form,
      warning_threshold: form.warning_threshold !== '' ? Number(form.warning_threshold) : null,
      critical_threshold: form.critical_threshold !== '' ? Number(form.critical_threshold) : null,
      instance_pk: form.scope === 'specific_instance' ? form.instance_pk : null,
      service_group: form.scope === 'service_group' ? form.service_group : null,
    };
    saveMut.mutate(body);
  };

  const set = (key: string, val: any) => setForm(f => ({ ...f, [key]: val }));
  const metricsForType = METRIC_TYPES[form.metric_type]?.metrics || {};

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-[#E2E8F0] flex items-center justify-between">
          <h2 className="font-semibold text-[#1E293B]">
            {rule ? 'Kural Düzenle' : 'Yeni Kural Oluştur'}
          </h2>
          <button onClick={onClose} className="text-[#94A3B8] hover:text-[#475569] text-xl">×</button>
        </div>

        {/* Adım göstergesi */}
        <div className="flex gap-0 border-b border-[#E2E8F0]">
          {['Metrik', 'Kapsam', 'Koşul', 'Davranış'].map((label, i) => (
            <button key={i} onClick={() => setStep(i + 1)}
              className={`flex-1 py-2 text-xs font-medium transition-colors border-b-2 ${step === i + 1 ? 'border-[#3B82F6] text-[#3B82F6]' : 'border-transparent text-[#94A3B8]'}`}>
              {i + 1}. {label}
            </button>
          ))}
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Adım 1: Metrik */}
          {step === 1 && (
            <>
              <div>
                <label className="block text-xs font-medium text-[#475569] mb-1">Kural Adı *</label>
                <input value={form.rule_name} onChange={e => set('rule_name', e.target.value)}
                  className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
                  placeholder="Örn: Production Cache Hit Düşük" />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#475569] mb-1">Açıklama</label>
                <input value={form.description} onChange={e => set('description', e.target.value)}
                  className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
                  placeholder="Opsiyonel açıklama" />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#475569] mb-1">Metrik Kategorisi *</label>
                <select value={form.metric_type} onChange={e => { set('metric_type', e.target.value); set('metric_name', Object.keys(METRIC_TYPES[e.target.value]?.metrics || {})[0] || ''); }}
                  className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]">
                  {Object.entries(METRIC_TYPES).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#475569] mb-1">Metrik *</label>
                <select value={form.metric_name} onChange={e => set('metric_name', e.target.value)}
                  className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]">
                  {Object.entries(metricsForType).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>
              </div>
            </>
          )}

          {/* Adım 2: Kapsam */}
          {step === 2 && (
            <>
              <div>
                <label className="block text-xs font-medium text-[#475569] mb-2">Kapsam *</label>
                <div className="space-y-2">
                  {[
                    { v: 'all_instances', l: 'Tüm Instance\'lar' },
                    { v: 'specific_instance', l: 'Belirli Instance' },
                    { v: 'service_group', l: 'Service Group' },
                  ].map(opt => (
                    <label key={opt.v} className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" checked={form.scope === opt.v} onChange={() => set('scope', opt.v)}
                        className="accent-[#3B82F6]" />
                      <span className="text-sm text-[#1E293B]">{opt.l}</span>
                    </label>
                  ))}
                </div>
              </div>
              {form.scope === 'specific_instance' && (
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">Instance *</label>
                  <select value={form.instance_pk ?? ''} onChange={e => set('instance_pk', e.target.value ? Number(e.target.value) : null)}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]">
                    <option value="">Seçiniz...</option>
                    {instances.map(i => <option key={i.instance_pk} value={i.instance_pk}>{i.display_name}</option>)}
                  </select>
                </div>
              )}
              {form.scope === 'service_group' && (
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">Service Group *</label>
                  <input value={form.service_group} onChange={e => set('service_group', e.target.value)}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
                    placeholder="Örn: production" />
                </div>
              )}
            </>
          )}

          {/* Adım 3: Koşul */}
          {step === 3 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">Operatör</label>
                  <select value={form.condition_operator} onChange={e => set('condition_operator', e.target.value)}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]">
                    {OPERATORS.map(op => <option key={op} value={op}>{op}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">Toplama</label>
                  <select value={form.aggregation} onChange={e => set('aggregation', e.target.value)}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]">
                    {Object.entries(AGGREGATIONS).map(([k, v]) => (
                      <option key={k} value={k}>{v}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">
                    <span className="inline-block w-2 h-2 bg-[#FBBF24] rounded-full mr-1"></span>
                    Uyarı Eşiği
                  </label>
                  <input type="number" value={form.warning_threshold} onChange={e => set('warning_threshold', e.target.value)}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
                    placeholder="Opsiyonel" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">
                    <span className="inline-block w-2 h-2 bg-[#EF4444] rounded-full mr-1"></span>
                    Kritik Eşiği
                  </label>
                  <input type="number" value={form.critical_threshold} onChange={e => set('critical_threshold', e.target.value)}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
                    placeholder="Opsiyonel" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[#475569] mb-1">Değerlendirme Penceresi</label>
                <select value={form.evaluation_window_minutes} onChange={e => set('evaluation_window_minutes', Number(e.target.value))}
                  className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]">
                  {WINDOW_OPTIONS.map(v => <option key={v} value={v}>Son {v} dakika</option>)}
                </select>
              </div>
            </>
          )}

          {/* Adım 4: Davranış */}
          {step === 4 && (
            <>
              <div>
                <label className="block text-xs font-medium text-[#475569] mb-1">Tekrar Alert Cooldown</label>
                <select value={form.cooldown_minutes} onChange={e => set('cooldown_minutes', Number(e.target.value))}
                  className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]">
                  {COOLDOWN_OPTIONS.map(v => <option key={v} value={v}>{v === 0 ? 'Cooldown yok' : `${v} dakika`}</option>)}
                </select>
              </div>
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.auto_resolve} onChange={e => set('auto_resolve', e.target.checked)}
                    className="accent-[#3B82F6] w-4 h-4" />
                  <span className="text-sm text-[#1E293B]">Eşik altına düşünce otomatik çöz</span>
                </label>
              </div>
              <div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.is_enabled} onChange={e => set('is_enabled', e.target.checked)}
                    className="accent-[#3B82F6] w-4 h-4" />
                  <span className="text-sm text-[#1E293B]">Kural aktif olsun</span>
                </label>
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t border-[#E2E8F0] flex justify-between">
          <button onClick={() => step > 1 ? setStep(s => s - 1) : onClose()}
            className="px-4 py-2 text-sm text-[#475569] hover:text-[#1E293B] transition-colors">
            {step > 1 ? '← Geri' : 'İptal'}
          </button>
          {step < 4 ? (
            <button onClick={() => setStep(s => s + 1)}
              className="px-5 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB] transition-colors">
              İleri →
            </button>
          ) : (
            <button onClick={handleSave} disabled={saveMut.isPending}
              className="px-5 py-2 bg-[#22C55E] text-white text-sm rounded-md hover:bg-[#16A34A] transition-colors disabled:opacity-50">
              {saveMut.isPending ? 'Kaydediliyor...' : (rule ? 'Güncelle' : 'Oluştur')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// =========================================================================
// Template'den Oluşturma Modal
// =========================================================================

function FromTemplateModal({ template, onClose }: { template: AlertRule; onClose: () => void }) {
  const qc = useQueryClient();
  const { addToast } = useToast();
  const [form, setForm] = useState({
    rule_name: template.rule_name,
    warning_threshold: template.warning_threshold ?? '' as string | number,
    critical_threshold: template.critical_threshold ?? '' as string | number,
    scope: 'all_instances',
    instance_pk: null as number | null,
    service_group: '',
  });

  const { data: instances = [] } = useQuery<Instance[]>({
    queryKey: ['instances-list'],
    queryFn: () => apiGet<any[]>('/instances').then(r => r.map((i: any) => ({ instance_pk: i.instance_pk, display_name: i.display_name }))),
  });

  const createMut = useMutation({
    mutationFn: (body: any) => apiPost('/alert-rules/from-template', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alert-rules'] });
      addToast('Kural oluşturuldu ve aktifleştirildi', 'success');
      onClose();
    },
    onError: (e: any) => addToast(e.message || 'Hata oluştu', 'error'),
  });

  const set = (key: string, val: any) => setForm(f => ({ ...f, [key]: val }));

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-[#E2E8F0] flex items-center justify-between">
          <h2 className="font-semibold text-[#1E293B]">Template Aktifleştir</h2>
          <button onClick={onClose} className="text-[#94A3B8] hover:text-[#475569] text-xl">×</button>
        </div>
        <div className="px-6 py-4 space-y-4">
          <div className="text-sm text-[#475569] bg-[#F8FAFC] rounded-md p-3">
            <strong>{template.rule_name}</strong>
            {template.description && <div className="mt-1 text-xs">{template.description}</div>}
          </div>
          <div>
            <label className="block text-xs font-medium text-[#475569] mb-1">Kural Adı</label>
            <input value={form.rule_name} onChange={e => set('rule_name', e.target.value)}
              className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#475569] mb-1">⚠ Uyarı Eşiği</label>
              <input type="number" value={form.warning_threshold} onChange={e => set('warning_threshold', e.target.value)}
                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]" />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#475569] mb-1">✕ Kritik Eşiği</label>
              <input type="number" value={form.critical_threshold} onChange={e => set('critical_threshold', e.target.value)}
                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]" />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#475569] mb-2">Kapsam</label>
            <div className="space-y-2">
              {[
                { v: 'all_instances', l: 'Tüm Instance\'lar' },
                { v: 'specific_instance', l: 'Belirli Instance' },
                { v: 'service_group', l: 'Service Group' },
              ].map(opt => (
                <label key={opt.v} className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={form.scope === opt.v} onChange={() => set('scope', opt.v)}
                    className="accent-[#3B82F6]" />
                  <span className="text-sm text-[#1E293B]">{opt.l}</span>
                </label>
              ))}
            </div>
            {form.scope === 'specific_instance' && (
              <select value={form.instance_pk ?? ''} onChange={e => set('instance_pk', e.target.value ? Number(e.target.value) : null)}
                className="mt-2 w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]">
                <option value="">Seçiniz...</option>
                {instances.map(i => <option key={i.instance_pk} value={i.instance_pk}>{i.display_name}</option>)}
              </select>
            )}
            {form.scope === 'service_group' && (
              <input value={form.service_group} onChange={e => set('service_group', e.target.value)}
                className="mt-2 w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
                placeholder="Örn: production" />
            )}
          </div>
        </div>
        <div className="px-6 py-4 border-t border-[#E2E8F0] flex justify-end gap-2">
          <button onClick={onClose}
            className="px-4 py-2 text-sm text-[#475569] hover:text-[#1E293B] transition-colors">
            İptal
          </button>
          <button onClick={() => createMut.mutate({
            template_rule_id: template.rule_id,
            rule_name: form.rule_name,
            warning_threshold: form.warning_threshold !== '' ? Number(form.warning_threshold) : null,
            critical_threshold: form.critical_threshold !== '' ? Number(form.critical_threshold) : null,
            scope: form.scope,
            instance_pk: form.scope === 'specific_instance' ? form.instance_pk : null,
            service_group: form.scope === 'service_group' ? form.service_group : null,
          })} disabled={createMut.isPending}
            className="px-5 py-2 bg-[#22C55E] text-white text-sm rounded-md hover:bg-[#16A34A] transition-colors disabled:opacity-50">
            {createMut.isPending ? 'Oluşturuluyor...' : 'Aktifleştir'}
          </button>
        </div>
      </div>
    </div>
  );
}
