import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, apiDelete, apiPatch } from '../api/client';
import { useToast } from '../components/common/Toast';

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
  evaluation_type: string;
  change_threshold_pct: number | null;
  min_data_days: number;
  alert_category: 'smart' | 'threshold';
  spike_fallback_pct: number | null;
  flatline_minutes: number;
  sensitivity: 'low' | 'medium' | 'high' | null;
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

// Her metrik için label, birim ve placeholder bilgisi
interface MetricDef {
  label: string;
  unit: string;        // gösterim birimi: "%", "MB", "saniye", "adet" vb.
  unitNote: string;    // eşik girerken gösterilecek açıklama
  placeholder?: string; // input placeholder
}

const METRIC_TYPES: Record<string, { label: string; metrics: Record<string, MetricDef> }> = {
  cluster_metric: {
    label: 'Cluster Sağlığı',
    metrics: {
      cache_hit_ratio:       { label: 'Cache Hit Ratio',        unit: '%',    unitNote: '0–100 arası yüzde. Örn: 95 = %95', placeholder: '95' },
      wal_bytes:             { label: 'WAL Üretimi',            unit: 'byte', unitNote: 'Byte cinsinden. Örn: 500000000 = ~476 MB', placeholder: '500000000' },
      checkpoint_write_time: { label: 'Checkpoint Yazma Süresi', unit: 'ms',  unitNote: 'Milisaniye. Örn: 30000 = 30 saniye', placeholder: '30000' },
      buffers_checkpoint:    { label: 'Checkpoint Buffer Yazımı', unit: 'adet', unitNote: 'Checkpoint sırasında yazılan buffer sayısı', placeholder: '1000' },
      buffers_clean:         { label: 'Bgwriter Buffer Temizleme', unit: 'adet', unitNote: 'Bgwriter tarafından temizlenen buffer sayısı', placeholder: '500' },
    },
  },
  activity_metric: {
    label: 'Bağlantı / Aktivite',
    metrics: {
      active_count:              { label: 'Aktif Bağlantı',          unit: 'adet', unitNote: 'Anlık aktif sorgu çalıştıran bağlantı sayısı', placeholder: '50' },
      idle_in_transaction_count: { label: 'Idle in Transaction',      unit: 'adet', unitNote: 'Transaction açık bekleyen bağlantı sayısı', placeholder: '5' },
      waiting_count:             { label: 'Kilit Bekleyen Bağlantı',  unit: 'adet', unitNote: 'Kilit için bekleyen sorgu sayısı', placeholder: '3' },
    },
  },
  replication_metric: {
    label: 'Replikasyon',
    metrics: {
      replay_lag_bytes:   { label: 'Replay Gecikme (veri)',  unit: 'byte', unitNote: 'Byte cinsinden. Örn: 52428800 = 50 MB, 524288000 = 500 MB', placeholder: '52428800' },
      replay_lag_seconds: { label: 'Replay Gecikme (süre)',  unit: 'sn',   unitNote: 'Saniye cinsinden. Örn: 60 = 1 dakika, 300 = 5 dakika', placeholder: '60' },
    },
  },
  database_metric: {
    label: 'Veritabanı',
    metrics: {
      deadlocks:      { label: 'Deadlock Sayısı',   unit: 'adet', unitNote: 'Pencere içindeki toplam deadlock sayısı', placeholder: '1' },
      temp_files:     { label: 'Geçici Dosya',       unit: 'adet', unitNote: 'Oluşturulan geçici dosya sayısı (work_mem yetersizliği)', placeholder: '50' },
      rollback_ratio: { label: 'Rollback Oranı',     unit: '%',    unitNote: "0–100 arası yüzde. Örn: 5 = commit'lerin %5'i rollback", placeholder: '5' },
      blk_read_time:  { label: 'Disk Okuma Süresi',  unit: 'ms',   unitNote: 'Milisaniye cinsinden toplam disk okuma süresi', placeholder: '1000' },
      blk_write_time: { label: 'Disk Yazma Süresi',  unit: 'ms',   unitNote: 'Milisaniye cinsinden toplam disk yazma süresi', placeholder: '1000' },
    },
  },
  statement_metric: {
    label: 'Sorgu (pg_stat_statements)',
    metrics: {
      avg_exec_time_ms:  { label: 'Ort. Çalışma Süresi',  unit: 'ms',   unitNote: 'Milisaniye. Örn: 1000 = 1 saniye, 5000 = 5 saniye', placeholder: '1000' },
      temp_blks_written: { label: 'Geçici Blok Yazımı',   unit: 'blok', unitNote: 'Pencere içindeki geçici blok yazım sayısı', placeholder: '10000' },
      calls:             { label: 'Çağrı Sayısı',          unit: 'adet', unitNote: 'Pencere içindeki toplam sorgu çağrı sayısı', placeholder: '10000' },
    },
  },
  table_metric: {
    label: 'Tablo',
    metrics: {
      dead_tuple_ratio: { label: 'Dead Tuple Oranı',       unit: '%',    unitNote: "0–100 arası yüzde. Örn: 20 = satırların %20'si ölü", placeholder: '20' },
      seq_scan:         { label: 'Sequential Scan Sayısı', unit: 'adet', unitNote: 'Pencere içindeki tam tablo tarama sayısı', placeholder: '10000' },
      n_tup_ins:        { label: 'INSERT Sayısı',          unit: 'adet', unitNote: 'Pencere içindeki INSERT sayısı', placeholder: '100000' },
    },
  },
  wal_metric: {
    label: 'WAL',
    metrics: {
      period_wal_size_byte:    { label: 'Dönem WAL Üretimi',     unit: 'byte', unitNote: 'İki ölçüm arasında üretilen WAL. Örn: 1073741824 = 1 GB', placeholder: '1073741824' },
      wal_directory_size_byte: { label: 'WAL Dizin Boyutu',      unit: 'byte', unitNote: 'pg_wal dizininin toplam boyutu. Örn: 5368709120 = 5 GB', placeholder: '5368709120' },
      wal_file_count:          { label: 'WAL Dosya Sayısı',      unit: 'adet', unitNote: 'pg_wal dizinindeki WAL dosyası sayısı', placeholder: '1000' },
    },
  },
  archiver_metric: {
    label: 'WAL Archiver',
    metrics: {
      archived_count: { label: 'Archive Edilen Sayısı',  unit: 'adet', unitNote: 'Kümülatif sayaç — başarıyla archive edilen WAL dosyası', placeholder: '1000' },
      failed_count:   { label: 'Archive Hata Sayısı',    unit: 'adet', unitNote: 'Kümülatif sayaç — archive_command hatası', placeholder: '10' },
    },
  },
  slot_metric: {
    label: 'Replication Slot',
    metrics: {
      slot_lag_bytes: { label: 'Slot Gecikme (byte)',  unit: 'byte', unitNote: 'current_wal_lsn - restart_lsn farkı. Örn: 1073741824 = 1 GB', placeholder: '1073741824' },
      spill_bytes:    { label: 'Decoder Spill (byte)', unit: 'byte', unitNote: 'PG14+ — logical decoding spill to disk', placeholder: '104857600' },
    },
  },
  conflict_metric: {
    label: 'Standby Conflict',
    metrics: {
      confl_tablespace: { label: 'Tablespace Conflict', unit: 'adet', unitNote: 'Standby recovery conflict sayısı', placeholder: '10' },
      confl_lock:       { label: 'Lock Conflict',       unit: 'adet', unitNote: 'Standby lock conflict sayısı', placeholder: '10' },
      confl_snapshot:   { label: 'Snapshot Conflict',   unit: 'adet', unitNote: 'Standby snapshot conflict sayısı', placeholder: '10' },
      confl_bufferpin:  { label: 'Buffer Pin Conflict', unit: 'adet', unitNote: 'Standby buffer pin conflict sayısı', placeholder: '10' },
      confl_deadlock:   { label: 'Deadlock Conflict',   unit: 'adet', unitNote: 'Standby deadlock sayısı', placeholder: '5' },
    },
  },
};

// Metrik için birim döndürür
function getUnit(metricType: string, metricName: string): string {
  return METRIC_TYPES[metricType]?.metrics[metricName]?.unit || '';
}

// Metrik için okunabilir label döndürür
function getMetricLabel(metricType: string, metricName: string): string {
  return METRIC_TYPES[metricType]?.metrics[metricName]?.label || metricName;
}

// Byte değerini okunabilir formata çevirir
function formatValue(value: number, unit: string): string {
  if (unit === 'byte') {
    if (value >= 1073741824) return (value / 1073741824).toFixed(1) + ' GB';
    if (value >= 1048576)    return (value / 1048576).toFixed(1) + ' MB';
    if (value >= 1024)       return (value / 1024).toFixed(1) + ' KB';
    return value + ' B';
  }
  if (unit === 'ms') {
    if (value >= 3600000) return (value / 3600000).toFixed(1) + ' sa';
    if (value >= 60000)   return (value / 60000).toFixed(1) + ' dk';
    if (value >= 1000)    return (value / 1000).toFixed(1) + ' sn';
    return value + ' ms';
  }
  if (unit === '%') return value + '%';
  if (unit === 'sn') {
    if (value >= 3600) return (value / 3600).toFixed(1) + ' sa';
    if (value >= 60)   return (value / 60).toFixed(1) + ' dk';
    return value + ' sn';
  }
  return String(value);
}

const OPERATORS = ['>', '<', '>=', '<=', '='];
const AGGREGATIONS: Record<string, string> = {
  avg: 'Ortalama',
  sum: 'Toplam',
  max: 'Maksimum',
  min: 'Minimum',
  last: 'Son Değer',
  count: 'Sayı',
};
const WINDOW_OPTIONS = [1, 5, 10, 15, 30, 60, 120, 240, 480, 1440];
const COOLDOWN_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 360];

const EVAL_TYPES: Record<string, { label: string; description: string; category: 'threshold' | 'smart' }> = {
  threshold:      { label: 'Sabit Eşik',             category: 'threshold', description: 'Değer belirlenen eşiği aştığında tetiklenir.' },
  alltime_high:   { label: 'Tüm Zamanlar En Yüksek', category: 'smart',     description: 'Değer geçmişte hiç bu kadar yüksek olmamışsa tetiklenir. Eşik gerekmez.' },
  alltime_low:    { label: 'Tüm Zamanlar En Düşük',  category: 'smart',     description: 'Değer geçmişte hiç bu kadar düşük olmamışsa tetiklenir. Eşik gerekmez.' },
  day_over_day:   { label: 'Günlük Değişim (%)',      category: 'smart',     description: 'Dünün aynı saatine göre % değişim eşiği aşılırsa tetiklenir.' },
  week_over_week: { label: 'Haftalık Değişim (%)',    category: 'smart',     description: 'Geçen haftanın aynı gününe göre % değişim eşiği aşılırsa tetiklenir.' },
  spike:          { label: 'Ani Sıçrama',             category: 'smart',     description: 'Son pencere ile önceki pencere karşılaştırılır. Ani artış tetiklenir.' },
  flatline:       { label: 'Counter Durdu',           category: 'smart',     description: 'Normalde artan bir değer N dakika boyunca hiç değişmediyse tetiklenir.' },
  hourly_pattern: { label: 'Saatlik Örüntü Sapması',  category: 'smart',     description: 'Bu saatin 4 haftalık ortalamasından sapma. Yeni instance\'ta anlık spike\'a geçer.' },
  adaptive:       { label: 'Adaptive (otomatik baseline)', category: 'smart', description: 'Gece hesaplanan 28 günlük baseline üzerinden otomatik eşik. Sensitivity ile hassasiyet ayarlanır.' },
};

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
  evaluation_type: 'threshold',
  change_threshold_pct: '' as string | number,
  min_data_days: 7,
  alert_category: 'threshold' as 'smart' | 'threshold',
  spike_fallback_pct: '' as string | number,
  flatline_minutes: 30,
  sensitivity: 'medium' as 'low' | 'medium' | 'high',
  is_enabled: true,
  cooldown_minutes: 15,
  auto_resolve: true,
};

// =========================================================================
// Ana Sayfa
// =========================================================================

export default function AlertRules() {
  const [tab, setTab] = useState<'smart' | 'custom' | 'templates'>('smart');
  const [showForm, setShowForm] = useState(false);
  const [editRule, setEditRule] = useState<AlertRule | null>(null);
  const [templateForm, setTemplateForm] = useState<AlertRule | null>(null);

  const tabs = [
    { k: 'smart',     l: '⚡ Hızlı İzleme',      hint: 'Eşik girmeden, tek tıkla aktifleştir' },
    { k: 'custom',    l: '⚙ Özel Kurallar',       hint: 'Manuel eşik tanımlı kurallar' },
    { k: 'templates', l: '📋 Template Galerisi',   hint: 'Hazır şablonlardan oluştur' },
  ];

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
        {tabs.map((t) => (
          <button key={t.k} onClick={() => setTab(t.k as any)}
            title={t.hint}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t.k ? 'border-[#3B82F6] text-[#3B82F6]' : 'border-transparent text-[#64748B] hover:text-[#1E293B]'}`}>
            {t.l}
          </button>
        ))}
      </div>

      {tab === 'smart' && (
        <SmartRulePanel onEdit={(rule) => { setEditRule(rule); setShowForm(true); }} />
      )}
      {tab === 'custom' && (
        <RuleList
          onEdit={(rule) => { setEditRule(rule); setShowForm(true); }}
          categoryFilter="threshold"
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

const EVAL_TYPE_BADGES: Record<string, { label: string; bg: string; text: string }> = {
  threshold:      { label: 'Sabit Eşik',    bg: 'bg-[#F1F5F9]', text: 'text-[#475569]' },
  alltime_high:   { label: 'Tüm Zaman ↑',  bg: 'bg-[#FDF4FF]', text: 'text-[#9333EA]' },
  alltime_low:    { label: 'Tüm Zaman ↓',  bg: 'bg-[#FDF4FF]', text: 'text-[#9333EA]' },
  day_over_day:   { label: 'Günlük %',      bg: 'bg-[#F0F9FF]', text: 'text-[#0284C7]' },
  week_over_week: { label: 'Haftalık %',    bg: 'bg-[#F0F9FF]', text: 'text-[#0284C7]' },
  spike:          { label: 'Ani Sıçrama',   bg: 'bg-[#FFF7ED]', text: 'text-[#EA580C]' },
  flatline:       { label: 'Counter Durdu', bg: 'bg-[#FEF2F2]', text: 'text-[#DC2626]' },
  hourly_pattern: { label: 'Saatlik Örüntü', bg: 'bg-[#F0FDF4]', text: 'text-[#16A34A]' },
  adaptive:       { label: 'Adaptive', bg: 'bg-[#ECFEFF]', text: 'text-[#0891B2]' },
};

// =========================================================================
// Smart Rule Panel — eşiksiz kuralları tek tıkla aç/kapat
// =========================================================================

function SmartRulePanel({ onEdit }: { onEdit: (r: AlertRule) => void }) {
  const qc = useQueryClient();
  const toast = useToast();

  const { data: rules = [], isLoading } = useQuery<AlertRule[]>({
    queryKey: ['alert-rules'],
    queryFn: () => apiGet('/alert-rules'),
  });

  const toggleMut = useMutation({
    mutationFn: (id: number) => apiPatch(`/alert-rules/${id}/toggle`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }),
    onError: () => toast.error('Toggle başarısız'),
  });

  const smartRules = rules.filter(r => r.alert_category === 'smart');

  if (isLoading) return <div className="text-[#64748B] text-sm">Yükleniyor...</div>;

  // Grupla
  const grouped: Record<string, AlertRule[]> = {};
  for (const r of smartRules) {
    const g = METRIC_TYPES[r.metric_type]?.label || r.metric_type;
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(r);
  }

  const activeCount = smartRules.filter(r => r.is_enabled).length;

  return (
    <div>
      {/* Başlık bilgi bandı */}
      <div className="mb-5 bg-[#EFF6FF] border border-[#BFDBFE] rounded-lg px-4 py-3 flex items-start gap-3">
        <span className="text-2xl">⚡</span>
        <div>
          <div className="text-sm font-semibold text-[#1E40AF]">Hızlı İzleme — Eşik Gerekmez</div>
          <div className="text-xs text-[#3B82F6] mt-0.5">
            Bu kurallar otomatik baseline hesaplar. Eşik girmeden toggle ile aktifleştir.
            {activeCount > 0 && <span className="ml-2 font-medium">{activeCount} kural aktif.</span>}
          </div>
        </div>
      </div>

      <div className="space-y-6">
        {Object.entries(grouped).map(([group, items]) => (
          <div key={group}>
            <h2 className="text-xs font-semibold text-[#94A3B8] uppercase tracking-wide mb-3">{group}</h2>
            <div className="space-y-2">
              {items.map((rule) => {
                const badge = EVAL_TYPE_BADGES[rule.evaluation_type] || EVAL_TYPE_BADGES.threshold;
                const evalDef = EVAL_TYPES[rule.evaluation_type];
                return (
                  <div key={rule.rule_id}
                    className={`bg-white border rounded-lg px-4 py-3 flex items-center gap-3 transition-colors ${rule.is_enabled ? 'border-[#BFDBFE]' : 'border-[#E2E8F0]'}`}>
                    {/* Toggle */}
                    <button
                      onClick={() => toggleMut.mutate(rule.rule_id)}
                      className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${rule.is_enabled ? 'bg-[#3B82F6]' : 'bg-[#CBD5E1]'}`}>
                      <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${rule.is_enabled ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>

                    {/* İçerik */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-[#1E293B]">{rule.rule_name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${badge.bg} ${badge.text}`}>
                          {badge.label}
                        </span>
                        {rule.open_alert_count > 0 && (
                          <span className="text-[10px] bg-[#FEE2E2] text-[#DC2626] px-1.5 py-0.5 rounded font-medium">
                            {rule.open_alert_count} açık alert
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-[#64748B] mt-0.5">
                        {evalDef?.description || rule.description || ''}
                      </div>
                      <div className="flex gap-3 mt-1 text-xs text-[#94A3B8]">
                        <span>{getMetricLabel(rule.metric_type, rule.metric_name)}</span>
                        {rule.change_threshold_pct != null && (
                          <span className="text-[#0284C7]">Eşik: %{rule.change_threshold_pct}</span>
                        )}
                        {rule.last_value != null && (
                          <span className={
                            rule.current_severity === 'critical' ? 'text-[#DC2626]' :
                            rule.current_severity === 'warning' ? 'text-[#D97706]' : 'text-[#16A34A]'
                          }>
                            şu an: {Number(rule.last_value).toFixed(1)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Düzenle */}
                    <button onClick={() => onEdit(rule)}
                      className="text-xs text-[#94A3B8] hover:text-[#475569] flex-shrink-0 px-2 py-1 hover:bg-[#F8FAFC] rounded">
                      Düzenle
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {smartRules.length === 0 && (
          <div className="text-center py-12 text-[#64748B] text-sm">
            Smart kural bulunamadı. Migration V017 uygulandı mı?
          </div>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// Kural Listesi — Özel (threshold) kurallar
// =========================================================================

function RuleList({ onEdit, categoryFilter: propCategoryFilter }: { onEdit: (r: AlertRule) => void; categoryFilter?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [evalFilter, setEvalFilter] = useState<string>('all');

  const { data: rules = [], isLoading } = useQuery<AlertRule[]>({
    queryKey: ['alert-rules'],
    queryFn: () => apiGet('/alert-rules'),
  });

  const toggleMut = useMutation({
    mutationFn: (id: number) => apiPatch(`/alert-rules/${id}/toggle`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alert-rules'] }),
    onError: () => toast.error('Toggle başarısız'),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiDelete(`/alert-rules/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['alert-rules'] }); toast.success('Kural silindi'); },
    onError: () => toast.error('Silme başarısız'),
  });

  if (isLoading) return <div className="text-[#64748B] text-sm">Yükleniyor...</div>;

  // propCategoryFilter='threshold' ise sadece threshold kategorisindeki kuralları göster
  const baseRules = propCategoryFilter
    ? rules.filter(r => r.alert_category === propCategoryFilter)
    : rules;

  if (baseRules.length === 0) return (
    <div className="text-center py-12 text-[#64748B] text-sm">
      Henüz özel kural yok. "+ Kural Ekle" butonunu veya "Template Galerisi" sekmesini kullanabilirsiniz.
    </div>
  );

  // Filtreleme
  const filtered = baseRules.filter(r => {
    if (categoryFilter !== 'all' && r.metric_type !== categoryFilter) return false;
    if (evalFilter !== 'all' && r.evaluation_type !== evalFilter) return false;
    return true;
  });

  // Kategori bazında grupla
  const grouped: Record<string, AlertRule[]> = {};
  for (const r of filtered) {
    const g = METRIC_TYPES[r.metric_type]?.label || r.metric_type;
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(r);
  }

  // Her kategoride kaç kural var (filtre yokken)
  const countByCategory: Record<string, number> = {};
  for (const r of baseRules) {
    if (evalFilter !== 'all' && r.evaluation_type !== evalFilter) continue;
    countByCategory[r.metric_type] = (countByCategory[r.metric_type] || 0) + 1;
  }
  const countByEval: Record<string, number> = {};
  for (const r of baseRules) {
    if (categoryFilter !== 'all' && r.metric_type !== categoryFilter) continue;
    countByEval[r.evaluation_type] = (countByEval[r.evaluation_type] || 0) + 1;
  }

  return (
    <div className="flex gap-5">
      {/* Sol filtre paneli */}
      <div className="w-48 flex-shrink-0 space-y-5">
        {/* Kategori filtresi */}
        <div>
          <div className="text-xs font-semibold text-[#94A3B8] uppercase tracking-wide mb-2">Kategori</div>
          <div className="space-y-0.5">
            <button onClick={() => setCategoryFilter('all')}
              className={`w-full text-left px-3 py-1.5 rounded text-sm flex justify-between items-center ${categoryFilter === 'all' ? 'bg-[#EFF6FF] text-[#2563EB] font-medium' : 'text-[#475569] hover:bg-[#F8FAFC]'}`}>
              <span>Tümü</span>
              <span className="text-xs text-[#94A3B8]">{baseRules.length}</span>
            </button>
            {Object.entries(METRIC_TYPES).map(([key, val]) => {
              const cnt = countByCategory[key] || 0;
              if (cnt === 0 && categoryFilter !== key) return null;
              return (
                <button key={key} onClick={() => setCategoryFilter(key)}
                  className={`w-full text-left px-3 py-1.5 rounded text-sm flex justify-between items-center ${categoryFilter === key ? 'bg-[#EFF6FF] text-[#2563EB] font-medium' : 'text-[#475569] hover:bg-[#F8FAFC]'}`}>
                  <span>{val.label}</span>
                  <span className="text-xs text-[#94A3B8]">{cnt}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Değerlendirme tipi filtresi */}
        <div>
          <div className="text-xs font-semibold text-[#94A3B8] uppercase tracking-wide mb-2">Tip</div>
          <div className="space-y-0.5">
            <button onClick={() => setEvalFilter('all')}
              className={`w-full text-left px-3 py-1.5 rounded text-sm flex justify-between items-center ${evalFilter === 'all' ? 'bg-[#EFF6FF] text-[#2563EB] font-medium' : 'text-[#475569] hover:bg-[#F8FAFC]'}`}>
              <span>Tümü</span>
            </button>
            {Object.entries(EVAL_TYPES).map(([key, val]) => {
              const cnt = countByEval[key] || 0;
              if (cnt === 0) return null;
              return (
                <button key={key} onClick={() => setEvalFilter(key)}
                  className={`w-full text-left px-3 py-1.5 rounded text-sm flex justify-between items-center ${evalFilter === key ? 'bg-[#EFF6FF] text-[#2563EB] font-medium' : 'text-[#475569] hover:bg-[#F8FAFC]'}`}>
                  <span className="truncate">{val.label}</span>
                  <span className="text-xs text-[#94A3B8] ml-1">{cnt}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Kural listesi — kategori gruplarına göre */}
      <div className="flex-1 min-w-0">
        {Object.keys(grouped).length === 0 && (
          <div className="text-center py-12 text-[#64748B] text-sm">Seçili filtreye uyan kural yok.</div>
        )}
        {Object.entries(grouped).map(([groupLabel, groupRules]) => (
          <div key={groupLabel} className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <h3 className="text-xs font-semibold text-[#64748B] uppercase tracking-wide">{groupLabel}</h3>
              <span className="text-xs text-[#94A3B8]">{groupRules.length} kural</span>
            </div>
            <div className="space-y-2">
              {groupRules.map((rule) => (
                <RuleCard key={rule.rule_id} rule={rule}
                  onToggle={() => toggleMut.mutate(rule.rule_id)}
                  onEdit={() => onEdit(rule)}
                  onDelete={() => { if (confirm(`"${rule.rule_name}" kuralını silmek istiyor musunuz?`)) deleteMut.mutate(rule.rule_id); }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RuleCard({ rule, onToggle, onEdit, onDelete }: {
  rule: AlertRule; onToggle: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const evalType = (rule as any).evaluation_type || 'threshold';
  const evalBadge = EVAL_TYPE_BADGES[evalType] || EVAL_TYPE_BADGES.threshold;
  const unit = getUnit(rule.metric_type, rule.metric_name);
  const isTrend = ['day_over_day', 'week_over_week'].includes(evalType);
  const changePct = (rule as any).change_threshold_pct;

  return (
    <div className={`bg-white border rounded-lg p-3.5 flex items-start gap-3 transition-colors ${rule.is_enabled ? 'border-[#E2E8F0]' : 'border-[#E2E8F0] opacity-60'}`}>
      {/* Toggle */}
      <button onClick={onToggle}
        className={`mt-0.5 w-9 h-5 rounded-full transition-colors flex-shrink-0 relative ${rule.is_enabled ? 'bg-[#22C55E]' : 'bg-[#CBD5E1]'}`}
        title={rule.is_enabled ? 'Pasif yap' : 'Aktif yap'}>
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${rule.is_enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
      </button>

      {/* Ana içerik */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm text-[#1E293B]">{rule.rule_name}</span>
          {/* Evaluation type badge */}
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${evalBadge.bg} ${evalBadge.text}`}>
            {evalBadge.label}
          </span>
          {/* Açık alert */}
          {rule.open_alert_count > 0 && (
            <span className="bg-[#FEE2E2] text-[#DC2626] text-[10px] px-1.5 py-0.5 rounded-full font-medium">
              {rule.open_alert_count} açık alert
            </span>
          )}
        </div>

        {/* Metrik + kapsam */}
        <div className="text-xs text-[#64748B] mt-0.5">
          {getMetricLabel(rule.metric_type, rule.metric_name)}
          {' · '}
          {rule.scope === 'all_instances' ? 'Tüm instance\'lar' :
           rule.scope === 'specific_instance' ? (rule.instance_name || `#${rule.instance_pk}`) :
           `Grup: ${rule.service_group}`}
        </div>

        {/* Koşul satırı */}
        <div className="flex flex-wrap items-center gap-2 mt-1.5">
          {isTrend ? (
            <span className="text-xs bg-[#F0F9FF] text-[#0369A1] px-2 py-0.5 rounded">
              %{changePct} değişim eşiği
            </span>
          ) : (
            <>
              {rule.warning_threshold != null && (
                <span className="text-xs bg-[#FEF3C7] text-[#D97706] px-2 py-0.5 rounded">
                  ⚠ {rule.condition_operator} {formatValue(rule.warning_threshold, unit)}
                </span>
              )}
              {rule.critical_threshold != null && (
                <span className="text-xs bg-[#FEE2E2] text-[#DC2626] px-2 py-0.5 rounded">
                  ✕ {rule.condition_operator} {formatValue(rule.critical_threshold, unit)}
                </span>
              )}
            </>
          )}
          <span className="text-xs text-[#94A3B8]">
            {rule.evaluation_window_minutes >= 1440
              ? `${rule.evaluation_window_minutes / 1440}g`
              : rule.evaluation_window_minutes >= 60
              ? `${rule.evaluation_window_minutes / 60}sa`
              : `${rule.evaluation_window_minutes}dk`} {AGGREGATIONS[rule.aggregation]}
          </span>
          {/* Son değer */}
          {rule.last_value != null && (
            <span className={`text-xs px-2 py-0.5 rounded ${
              rule.current_severity === 'critical' ? 'bg-[#FEE2E2] text-[#DC2626]' :
              rule.current_severity === 'warning'  ? 'bg-[#FEF3C7] text-[#D97706]' :
              'bg-[#F0FDF4] text-[#16A34A]'
            }`}>
              şu an: {isTrend ? `%${Number(rule.last_value).toFixed(1)}` : formatValue(Number(rule.last_value), unit)}
            </span>
          )}
        </div>
      </div>

      {/* Aksiyon butonları */}
      <div className="flex gap-1 flex-shrink-0">
        <button onClick={onEdit}
          className="px-2.5 py-1 text-xs bg-[#F1F5F9] text-[#475569] rounded hover:bg-[#E2E8F0] transition-colors">
          Düzenle
        </button>
        <button onClick={onDelete}
          className="px-2.5 py-1 text-xs bg-[#FEE2E2] text-[#DC2626] rounded hover:bg-[#FECACA] transition-colors">
          Sil
        </button>
      </div>
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
                      ⚠ {tpl.condition_operator} {formatValue(tpl.warning_threshold!, getUnit(tpl.metric_type, tpl.metric_name))}
                    </span>
                  )}
                  {tpl.critical_threshold != null && (
                    <span className="text-xs bg-[#FEE2E2] text-[#DC2626] px-2 py-0.5 rounded">
                      ✕ {tpl.condition_operator} {formatValue(tpl.critical_threshold!, getUnit(tpl.metric_type, tpl.metric_name))}
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
  const toast = useToast();
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
      evaluation_type: rule.evaluation_type || 'threshold',
      change_threshold_pct: rule.change_threshold_pct ?? '' as string | number,
      min_data_days: rule.min_data_days ?? 7,
      alert_category: rule.alert_category ?? 'threshold',
      spike_fallback_pct: rule.spike_fallback_pct ?? '' as string | number,
      flatline_minutes: rule.flatline_minutes ?? 30,
      sensitivity: rule.sensitivity ?? 'medium',
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
      toast.success(rule ? 'Kural güncellendi' : 'Kural oluşturuldu');
      onClose();
    },
    onError: (e: any) => toast.error(e.message || 'Hata oluştu'),
  });

  const handleSave = () => {
    const needsChangePct = ['day_over_day', 'week_over_week', 'spike', 'hourly_pattern'].includes(form.evaluation_type);
    const body = {
      ...form,
      warning_threshold: form.evaluation_type === 'threshold' && form.warning_threshold !== '' ? Number(form.warning_threshold) : null,
      critical_threshold: form.evaluation_type === 'threshold' && form.critical_threshold !== '' ? Number(form.critical_threshold) : null,
      change_threshold_pct: needsChangePct && form.change_threshold_pct !== '' ? Number(form.change_threshold_pct) : null,
      spike_fallback_pct: form.spike_fallback_pct !== '' ? Number(form.spike_fallback_pct) : null,
      instance_pk: form.scope === 'specific_instance' ? form.instance_pk : null,
      service_group: form.scope === 'service_group' ? form.service_group : null,
      alert_category: EVAL_TYPES[form.evaluation_type]?.category ?? 'threshold',
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
                  {Object.entries(metricsForType).map(([k, def]) => (
                    <option key={k} value={k}>{(def as any).label ?? k}</option>
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
              {/* Değerlendirme tipi */}
              <div>
                <label className="block text-xs font-medium text-[#475569] mb-2">Değerlendirme Yöntemi</label>
                <div className="space-y-2">
                  {Object.entries(EVAL_TYPES).map(([k, v]) => (
                    <label key={k} className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${form.evaluation_type === k ? 'border-[#3B82F6] bg-[#EFF6FF]' : 'border-[#E2E8F0] hover:border-[#93C5FD]'}`}>
                      <input type="radio" checked={form.evaluation_type === k} onChange={() => set('evaluation_type', k)}
                        className="mt-0.5 accent-[#3B82F6]" />
                      <div>
                        <div className="text-sm font-medium text-[#1E293B]">{v.label}</div>
                        <div className="text-xs text-[#64748B] mt-0.5">{v.description}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {/* Trend / Spike / Hourly: % değişim eşiği */}
              {['day_over_day', 'week_over_week', 'spike', 'hourly_pattern'].includes(form.evaluation_type) && (
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">
                    Değişim Eşiği (%) *
                  </label>
                  <input type="number" min="1" max="10000"
                    value={form.change_threshold_pct}
                    onChange={e => set('change_threshold_pct', e.target.value)}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
                    placeholder="Örn: 100 = %100 artış" />
                  <p className="text-xs text-[#64748B] mt-1">
                    {{
                      day_over_day: 'Dünün aynı saatine göre mutlak değişim bu yüzdeyi aşarsa tetiklenir.',
                      week_over_week: 'Geçen haftanın aynı gününe göre mutlak değişim bu yüzdeyi aşarsa tetiklenir.',
                      spike: 'Son pencere ile önceki pencere arasındaki artış bu yüzdeyi aşarsa tetiklenir.',
                      hourly_pattern: 'Bu saatin 4 haftalık ortalamasından sapma bu yüzdeyi aşarsa tetiklenir.',
                    }[form.evaluation_type] || ''}
                  </p>
                </div>
              )}

              {/* Spike / Hourly: fallback eşiği (yeni instance için) */}
              {['spike', 'hourly_pattern'].includes(form.evaluation_type) && (
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">
                    Yeni Instance Fallback Eşiği (%) <span className="text-[#94A3B8] font-normal">— opsiyonel</span>
                  </label>
                  <input type="number" min="1" max="100000"
                    value={form.spike_fallback_pct}
                    onChange={e => set('spike_fallback_pct', e.target.value)}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
                    placeholder="Örn: 300 — yeterli veri yoksa ani %300 artışı yine de yakala" />
                  <p className="text-xs text-[#64748B] mt-1">
                    Henüz yeterli geçmişi olmayan instance'larda bu eşik kullanılır. Boş bırakılırsa yeni instance'lar değerlendirilmez.
                  </p>
                </div>
              )}

              {/* Adaptive: sensitivity */}
              {form.evaluation_type === 'adaptive' && (
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">
                    Hassasiyet (Sensitivity) *
                  </label>
                  <select value={form.sensitivity} onChange={e => set('sensitivity', e.target.value)}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]">
                    <option value="low">Düşük — avg + 3σ (az alarm)</option>
                    <option value="medium">Orta — avg + 2σ (dengeli)</option>
                    <option value="high">Yüksek — avg + 1.5σ (çok alarm)</option>
                  </select>
                  <p className="text-xs text-[#64748B] mt-1">
                    Baseline gece hesaplanır. Bu instance için en az 7 gün veri yoksa kural atlanır.
                  </p>
                </div>
              )}

              {/* Flatline: hareketsizlik süresi */}
              {form.evaluation_type === 'flatline' && (
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">
                    Hareketsizlik Süresi (dakika) *
                  </label>
                  <input type="number" min="5" max="1440"
                    value={form.flatline_minutes}
                    onChange={e => set('flatline_minutes', Number(e.target.value))}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
                    placeholder="30" />
                  <p className="text-xs text-[#64748B] mt-1">
                    Metrik bu kadar dakika boyunca hiç değişmezse alert tetiklenir.
                  </p>
                </div>
              )}

              {/* Alltime / Trend / Smart: min data günü */}
              {['alltime_high', 'alltime_low', 'day_over_day', 'week_over_week', 'spike', 'hourly_pattern'].includes(form.evaluation_type) && (
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">
                    Minimum Geçmiş Veri (gün)
                  </label>
                  <input type="number" min="1" max="365"
                    value={form.min_data_days}
                    onChange={e => set('min_data_days', Number(e.target.value))}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]" />
                  <p className="text-xs text-[#64748B] mt-1">
                    Bu kadar günlük veri yoksa kural değerlendirilmez (false positive önlemi).
                  </p>
                </div>
              )}

              {/* Threshold: sabit eşik alanları */}
              {form.evaluation_type === 'threshold' && (<>
              <div>
                <label className="block text-xs font-medium text-[#475569] mb-1">Operatör</label>
                <select value={form.condition_operator} onChange={e => set('condition_operator', e.target.value)}
                  className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]">
                  {OPERATORS.map(op => <option key={op} value={op}>{op}</option>)}
                </select>
              </div>
              {/* Birim notu */}
              {(() => {
                const metricDef = METRIC_TYPES[form.metric_type]?.metrics[form.metric_name];
                return metricDef ? (
                  <div className="text-xs bg-[#F0F9FF] border border-[#BAE6FD] text-[#0369A1] px-3 py-2 rounded-md">
                    <strong>Birim:</strong> {metricDef.unitNote}
                  </div>
                ) : null;
              })()}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">
                    <span className="inline-block w-2 h-2 bg-[#FBBF24] rounded-full mr-1"></span>
                    Uyarı Eşiği {METRIC_TYPES[form.metric_type]?.metrics[form.metric_name]?.unit ? `(${METRIC_TYPES[form.metric_type].metrics[form.metric_name].unit})` : ''}
                  </label>
                  <input type="number" value={form.warning_threshold} onChange={e => set('warning_threshold', e.target.value)}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
                    placeholder={METRIC_TYPES[form.metric_type]?.metrics[form.metric_name]?.placeholder || 'Opsiyonel'} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">
                    <span className="inline-block w-2 h-2 bg-[#EF4444] rounded-full mr-1"></span>
                    Kritik Eşiği {METRIC_TYPES[form.metric_type]?.metrics[form.metric_name]?.unit ? `(${METRIC_TYPES[form.metric_type].metrics[form.metric_name].unit})` : ''}
                  </label>
                  <input type="number" value={form.critical_threshold} onChange={e => set('critical_threshold', e.target.value)}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
                    placeholder={METRIC_TYPES[form.metric_type]?.metrics[form.metric_name]?.placeholder || 'Opsiyonel'} />
                </div>
              </div>
              </>)}
              {/* Tüm tipler için pencere + aggregation */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[#475569] mb-1">
                    {['day_over_day','week_over_week'].includes(form.evaluation_type) ? 'Karşılaştırma Penceresi' : 'Değerlendirme Penceresi'}
                  </label>
                  <select value={form.evaluation_window_minutes} onChange={e => set('evaluation_window_minutes', Number(e.target.value))}
                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]">
                    {WINDOW_OPTIONS.map(v => <option key={v} value={v}>{v >= 1440 ? `${v/1440} gün` : v >= 60 ? `${v/60} saat` : `${v} dakika`}</option>)}
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
  const toast = useToast();
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
      toast.success('Kural oluşturuldu ve aktifleştirildi');
      onClose();
    },
    onError: (e: any) => toast.error(e.message || 'Hata oluştu'),
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
          {/* Birim notu */}
          {(() => {
            const metricDef = METRIC_TYPES[template.metric_type]?.metrics[template.metric_name];
            return metricDef ? (
              <div className="text-xs bg-[#F0F9FF] border border-[#BAE6FD] text-[#0369A1] px-3 py-2 rounded-md">
                <strong>Birim:</strong> {metricDef.unitNote}
              </div>
            ) : null;
          })()}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#475569] mb-1">
                ⚠ Uyarı Eşiği {getUnit(template.metric_type, template.metric_name) ? `(${getUnit(template.metric_type, template.metric_name)})` : ''}
              </label>
              <input type="number" value={form.warning_threshold} onChange={e => set('warning_threshold', e.target.value)}
                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
                placeholder={METRIC_TYPES[template.metric_type]?.metrics[template.metric_name]?.placeholder} />
            </div>
            <div>
              <label className="block text-xs font-medium text-[#475569] mb-1">
                ✕ Kritik Eşiği {getUnit(template.metric_type, template.metric_name) ? `(${getUnit(template.metric_type, template.metric_name)})` : ''}
              </label>
              <input type="number" value={form.critical_threshold} onChange={e => set('critical_threshold', e.target.value)}
                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
                placeholder={METRIC_TYPES[template.metric_type]?.metrics[template.metric_name]?.placeholder} />
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
