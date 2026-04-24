import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../api/client';
import TimeAgo from '../components/common/TimeAgo';

interface Summary {
  total_instances: number;
  ready_instances: number;
  degraded_instances: number;
  bootstrapping_instances: number;
  open_alerts: number;
  critical_alerts: number;
  warning_alerts: number;
}

interface InstanceHealth {
  instance_pk: number;
  instance_id: string;
  display_name: string;
  environment: string | null;
  service_group: string | null;
  host: string;
  port: number;
  bootstrap_state: string;
  pg_major: number | null;
  is_primary: boolean | null;
  consecutive_failures: number;
  last_success_at: string | null;
  open_alerts: number;
  critical_alerts: number;
}

interface InstanceMetrics {
  instance_pk: number;
  qps: number;
  client_connections: number;
  max_replay_lag_sec: number | null;
  total_dead_tuples: number;
}

interface WalProduction {
  instance_pk: number;
  display_name: string;
  wal_bytes_per_hour: number | null;
}

interface ArchiverFailure {
  instance_pk: number;
  display_name: string;
  failed_count: number;
  last_failed_wal: string | null;
  last_failed_time: string | null;
}

interface SlruCacheMiss {
  instance_pk: number;
  display_name: string;
  total_blks_read: number;
  total_blks_hit: number;
  hit_ratio: number;
}

interface AlertSeverityCount {
  severity: string;
  count: number;
}

type HealthColor = 'green' | 'yellow' | 'red' | 'blue' | 'gray';

function getHealthColor(inst: InstanceHealth): HealthColor {
  if (inst.bootstrap_state === 'degraded') return 'red';
  if (inst.consecutive_failures > 2) return 'red';
  if (inst.consecutive_failures > 0) return 'yellow';
  if (inst.critical_alerts > 0) return 'red';
  if (inst.open_alerts > 0) return 'yellow';
  if (['discovering', 'baselining', 'enriching'].includes(inst.bootstrap_state)) return 'blue';
  if (inst.bootstrap_state === 'pending') return 'gray';
  return 'green';
}

const TILE_COLORS: Record<HealthColor, { bg: string; dot: string; label: string }> = {
  green: { bg: 'bg-green-50 border-green-200 hover:border-green-400', dot: 'bg-green-500', label: 'text-green-700' },
  yellow: { bg: 'bg-amber-50 border-amber-200 hover:border-amber-400', dot: 'bg-amber-500', label: 'text-amber-700' },
  red: { bg: 'bg-red-50 border-red-200 hover:border-red-400', dot: 'bg-red-500', label: 'text-red-700' },
  blue: { bg: 'bg-blue-50 border-blue-200 hover:border-blue-400', dot: 'bg-blue-500', label: 'text-blue-700' },
  gray: { bg: 'bg-gray-50 border-gray-200 hover:border-gray-400', dot: 'bg-gray-400', label: 'text-gray-500' },
};

const STATE_LABELS: Record<string, string> = {
  ready: 'Hazır',
  degraded: 'Degraded',
  pending: 'Bekliyor',
  discovering: 'Keşfediliyor',
  baselining: 'Baseline',
  enriching: 'Zenginleştiriliyor',
};

function stateLabel(s: string) {
  return STATE_LABELS[s] ?? s;
}

function formatLag(sec: number | null): string {
  if (sec === null || sec < 0) return '-';
  if (sec < 1) return '<1s';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}dk`;
  return `${Math.round(sec / 3600)}sa`;
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [envFilter, setEnvFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [groupBy, setGroupBy] = useState<'environment' | 'none'>('environment');

  const summary = useQuery({
    queryKey: ['dash-summary'],
    queryFn: () => apiGet<Summary>('/dashboard/summary'),
    refetchInterval: 30_000,
  });

  const health = useQuery({
    queryKey: ['dash-health'],
    queryFn: () => apiGet<InstanceHealth[]>('/dashboard/instance-health'),
    refetchInterval: 30_000,
  });

  const metricsQuery = useQuery({
    queryKey: ['dash-metrics'],
    queryFn: () => apiGet<InstanceMetrics[]>('/dashboard/instance-metrics'),
    refetchInterval: 30_000,
  });

  const walQuery = useQuery({
    queryKey: ['dash-wal'],
    queryFn: () => apiGet<WalProduction[]>('/dashboard/wal-production'),
    refetchInterval: 30_000,
  });

  const archiverQuery = useQuery({
    queryKey: ['dash-archiver'],
    queryFn: () => apiGet<ArchiverFailure[]>('/dashboard/archiver-failures'),
    refetchInterval: 30_000,
  });

  const slruQuery = useQuery({
    queryKey: ['dash-slru'],
    queryFn: () => apiGet<SlruCacheMiss[]>('/dashboard/slru-cache-miss'),
    refetchInterval: 30_000,
  });

  const alertSummaryQuery = useQuery({
    queryKey: ['dash-alert-summary'],
    queryFn: () => apiGet<AlertSeverityCount[]>('/dashboard/alert-summary'),
    refetchInterval: 30_000,
  });

  const s = summary.data;
  const instances = health.data ?? [];

  const metricsMap = useMemo(() => {
    const map = new Map<number, InstanceMetrics>();
    (metricsQuery.data ?? []).forEach(m => map.set(Number(m.instance_pk), m));
    return map;
  }, [metricsQuery.data]);

  const environments = useMemo(() => {
    const envs = new Set(instances.map(i => i.environment).filter(Boolean) as string[]);
    return Array.from(envs).sort();
  }, [instances]);

  const filtered = useMemo(() => {
    return instances.filter(i => {
      if (search) {
        const q = search.toLowerCase();
        if (!i.display_name.toLowerCase().includes(q) && !i.host.toLowerCase().includes(q)) return false;
      }
      if (envFilter && i.environment !== envFilter) return false;
      if (stateFilter === 'issues') {
        const hasIssue = i.bootstrap_state === 'degraded' || i.consecutive_failures > 0 || i.open_alerts > 0;
        if (!hasIssue) return false;
      } else if (stateFilter === 'bootstrapping') {
        if (!['discovering', 'baselining', 'enriching'].includes(i.bootstrap_state)) return false;
      } else if (stateFilter) {
        if (i.bootstrap_state !== stateFilter) return false;
      }
      return true;
    });
  }, [instances, search, envFilter, stateFilter]);

  // Instances needing attention (shown in dedicated section)
  const attentionInstances = useMemo(() => {
    return instances.filter(i =>
      i.bootstrap_state === 'degraded' ||
      i.consecutive_failures > 0 ||
      i.critical_alerts > 0
    );
  }, [instances]);

  // Top-N lists
  const topQps = useMemo(() =>
    [...instances]
      .map(i => ({ inst: i, m: metricsMap.get(i.instance_pk) }))
      .filter(x => x.m && Number(x.m.qps) > 0)
      .sort((a, b) => Number(b.m!.qps) - Number(a.m!.qps))
      .slice(0, 5),
    [instances, metricsMap]);

  const topConnections = useMemo(() =>
    [...instances]
      .map(i => ({ inst: i, m: metricsMap.get(i.instance_pk) }))
      .filter(x => x.m)
      .sort((a, b) => Number(b.m!.client_connections) - Number(a.m!.client_connections))
      .slice(0, 5),
    [instances, metricsMap]);

  const topLag = useMemo(() =>
    [...instances]
      .map(i => ({ inst: i, m: metricsMap.get(i.instance_pk) }))
      .filter(x => x.m && x.m.max_replay_lag_sec !== null)
      .sort((a, b) => Number(b.m!.max_replay_lag_sec) - Number(a.m!.max_replay_lag_sec))
      .slice(0, 5),
    [instances, metricsMap]);

  const topDeadTuples = useMemo(() =>
    [...instances]
      .map(i => ({ inst: i, m: metricsMap.get(i.instance_pk) }))
      .filter(x => x.m && Number(x.m.total_dead_tuples) > 0)
      .sort((a, b) => Number(b.m!.total_dead_tuples) - Number(a.m!.total_dead_tuples))
      .slice(0, 5),
    [instances, metricsMap]);

  const hasTopData = topQps.length > 0 || topConnections.length > 0 || topLag.length > 0 || topDeadTuples.length > 0;

  const walData = walQuery.data ?? [];
  const archiverData = archiverQuery.data ?? [];
  const slruData = slruQuery.data ?? [];
  const alertSummary = alertSummaryQuery.data ?? [];
  const hasNewMetrics = walData.length > 0 || archiverData.length > 0 || slruData.length > 0 || alertSummary.length > 0;

  // Group filtered instances
  const groups = useMemo(() => {
    if (groupBy === 'none') {
      return [{ key: '', label: '', items: filtered }];
    }
    const map = new Map<string, InstanceHealth[]>();
    filtered.forEach(i => {
      const key = i.environment ?? '(ortam yok)';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(i);
    });
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, items]) => ({ key, label: key, items }));
  }, [filtered, groupBy]);

  const isFetching = summary.isFetching || health.isFetching || metricsQuery.isFetching || walQuery.isFetching || archiverQuery.isFetching || slruQuery.isFetching || alertSummaryQuery.isFetching;

  function renderTile(inst: InstanceHealth) {
    const color = getHealthColor(inst);
    const c = TILE_COLORS[color];
    const m = metricsMap.get(inst.instance_pk);

    return (
      <div
        key={inst.instance_pk}
        onClick={() => navigate(`/cluster/${inst.instance_pk}`)}
        className={`border rounded-lg p-3 cursor-pointer transition-all select-none ${c.bg}`}
      >
        <div className="flex items-start justify-between gap-1 mb-1.5">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${c.dot}`} />
            <span className="font-medium text-sm truncate text-[#1E293B]">{inst.display_name}</span>
          </div>
          {inst.open_alerts > 0 && (
            <span className="text-[10px] bg-red-100 text-red-700 rounded px-1.5 py-0.5 flex-shrink-0 font-medium">
              {inst.open_alerts} alert
            </span>
          )}
        </div>

        <div className="text-xs text-[#64748B] space-y-0.5">
          <div className="truncate">{inst.host}:{inst.port}</div>
          <div className="flex items-center gap-2 flex-wrap">
            {inst.pg_major && <span>PG{inst.pg_major}</span>}
            {inst.is_primary !== null && (
              <span className={inst.is_primary ? 'text-blue-600' : 'text-purple-600'}>
                {inst.is_primary ? 'Primary' : 'Replica'}
              </span>
            )}
            <span className={`${c.label} font-medium`}>{stateLabel(inst.bootstrap_state)}</span>
          </div>
          {m && (
            <div className="flex items-center gap-2 text-[10px] text-[#94A3B8] mt-0.5">
              <span>{Number(m.qps)} QPS</span>
              <span>·</span>
              <span>{Number(m.client_connections)} bağlantı</span>
            </div>
          )}
          {inst.consecutive_failures > 0 && (
            <div className="text-red-600 text-[10px] font-medium mt-0.5">
              {inst.consecutive_failures} başarısız
            </div>
          )}
          {inst.last_success_at && (
            <div className="text-[10px] text-[#94A3B8] mt-0.5">
              <TimeAgo date={inst.last_success_at} />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold">Dashboard</h1>
        <button
          onClick={() => { summary.refetch(); health.refetch(); metricsQuery.refetch(); walQuery.refetch(); archiverQuery.refetch(); slruQuery.refetch(); alertSummaryQuery.refetch(); }}
          className="text-xs text-[#64748B] hover:text-[#1E293B] transition-colors px-3 py-1.5 border border-[#E2E8F0] rounded-md hover:border-[#CBD5E1]"
        >
          {isFetching ? 'Yenileniyor...' : 'Yenile'}
        </button>
      </div>

      {/* Özet kartları */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-lg shadow-sm p-4">
          <div className="text-xs text-[#64748B] mb-1">Toplam Instance</div>
          <div className="text-2xl font-bold text-[#1E293B]">{s?.total_instances ?? 0}</div>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-4">
          <div className="text-xs text-[#64748B] mb-1">Hazır</div>
          <div className="text-2xl font-bold text-green-600">{s?.ready_instances ?? 0}</div>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-4">
          <div className="text-xs text-[#64748B] mb-1">Degraded / Bootstrap</div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-red-600">{s?.degraded_instances ?? 0}</span>
            {(s?.bootstrapping_instances ?? 0) > 0 && (
              <span className="text-sm text-blue-600">+{s!.bootstrapping_instances}</span>
            )}
          </div>
        </div>
        <div className="bg-white rounded-lg shadow-sm p-4">
          <div className="text-xs text-[#64748B] mb-1">Açık Alert</div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold text-amber-600">{s?.open_alerts ?? 0}</span>
            {(s?.critical_alerts ?? 0) > 0 && (
              <span className="text-xs text-red-600 font-medium">{s!.critical_alerts} kritik</span>
            )}
          </div>
        </div>
      </div>

      {/* Dikkat Gereken */}
      {attentionInstances.length > 0 && (
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" />
            <h2 className="text-sm font-semibold text-red-600">
              Dikkat Gereken ({attentionInstances.length})
            </h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {attentionInstances.map(inst => renderTile(inst))}
          </div>
        </div>
      )}

      {/* Top-N widget'ları */}
      {hasTopData && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
          {topQps.length > 0 && (
            <div className="bg-white rounded-lg shadow-sm p-4">
              <div className="text-xs font-semibold text-[#64748B] mb-3 uppercase tracking-wide">
                En Yüksek QPS
              </div>
              <div className="space-y-2">
                {topQps.map(({ inst, m }) => (
                  <div key={inst.instance_pk} className="flex items-center justify-between text-sm">
                    <span
                      className="truncate text-[#1E293B] cursor-pointer hover:text-blue-600"
                      onClick={() => navigate(`/cluster/${inst.instance_pk}`)}
                    >
                      {inst.display_name}
                    </span>
                    <span className="font-mono font-semibold text-blue-600 ml-2 flex-shrink-0">
                      {Number(m!.qps)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {topConnections.length > 0 && (
            <div className="bg-white rounded-lg shadow-sm p-4">
              <div className="text-xs font-semibold text-[#64748B] mb-3 uppercase tracking-wide">
                En Fazla Bağlantı
              </div>
              <div className="space-y-2">
                {topConnections.map(({ inst, m }) => (
                  <div key={inst.instance_pk} className="flex items-center justify-between text-sm">
                    <span
                      className="truncate text-[#1E293B] cursor-pointer hover:text-blue-600"
                      onClick={() => navigate(`/cluster/${inst.instance_pk}`)}
                    >
                      {inst.display_name}
                    </span>
                    <span className="font-mono font-semibold text-green-600 ml-2 flex-shrink-0">
                      {Number(m!.client_connections)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {topLag.length > 0 && (
            <div className="bg-white rounded-lg shadow-sm p-4">
              <div className="text-xs font-semibold text-[#64748B] mb-3 uppercase tracking-wide">
                Replikasyon Gecikmesi
              </div>
              <div className="space-y-2">
                {topLag.map(({ inst, m }) => (
                  <div key={inst.instance_pk} className="flex items-center justify-between text-sm">
                    <span
                      className="truncate text-[#1E293B] cursor-pointer hover:text-blue-600"
                      onClick={() => navigate(`/cluster/${inst.instance_pk}`)}
                    >
                      {inst.display_name}
                    </span>
                    <span className={`font-mono font-semibold ml-2 flex-shrink-0 ${Number(m!.max_replay_lag_sec) > 30 ? 'text-red-600' : 'text-amber-600'}`}>
                      {formatLag(m!.max_replay_lag_sec)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {topDeadTuples.length > 0 && (
            <div className="bg-white rounded-lg shadow-sm p-4">
              <div className="text-xs font-semibold text-[#64748B] mb-3 uppercase tracking-wide">
                En Fazla Dead Tuple
              </div>
              <div className="space-y-2">
                {topDeadTuples.map(({ inst, m }) => (
                  <div key={inst.instance_pk} className="flex items-center justify-between text-sm">
                    <span
                      className="truncate text-[#1E293B] cursor-pointer hover:text-blue-600"
                      onClick={() => navigate(`/cluster/${inst.instance_pk}`)}
                    >
                      {inst.display_name}
                    </span>
                    <span className="font-mono font-semibold text-orange-600 ml-2 flex-shrink-0">
                      {formatNum(Number(m!.total_dead_tuples))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Yeni Metrik Widget'ları: WAL, Archiver, SLRU, Alert Özeti */}
      {hasNewMetrics && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
          {walData.length > 0 && (
            <div className="bg-white rounded-lg shadow-sm p-4">
              <div className="text-xs font-semibold text-[#64748B] mb-3 uppercase tracking-wide">
                WAL Üretimi (byte/saat)
              </div>
              <div className="space-y-2">
                {walData.map(w => (
                  <div key={w.instance_pk} className="flex items-center justify-between text-sm">
                    <span className="truncate text-[#1E293B] cursor-pointer hover:text-blue-600"
                      onClick={() => navigate(`/cluster/${w.instance_pk}`)}>
                      {w.display_name}
                    </span>
                    <span className="font-mono font-semibold text-purple-600 ml-2 flex-shrink-0">
                      {formatBytes(Number(w.wal_bytes_per_hour || 0))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {archiverData.length > 0 && (
            <div className="bg-white rounded-lg shadow-sm p-4">
              <div className="text-xs font-semibold text-[#64748B] mb-3 uppercase tracking-wide">
                Archiver Hataları
              </div>
              <div className="space-y-2">
                {archiverData.map(a => (
                  <div key={a.instance_pk} className="flex items-center justify-between text-sm">
                    <span className="truncate text-[#1E293B] cursor-pointer hover:text-blue-600"
                      onClick={() => navigate(`/cluster/${a.instance_pk}`)}>
                      {a.display_name}
                    </span>
                    <span className="font-mono font-semibold text-red-600 ml-2 flex-shrink-0">
                      {Number(a.failed_count)} başarısız
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {slruData.length > 0 && (
            <div className="bg-white rounded-lg shadow-sm p-4">
              <div className="text-xs font-semibold text-[#64748B] mb-3 uppercase tracking-wide">
                SLRU Cache Miss
              </div>
              <div className="space-y-2">
                {slruData.map(s => (
                  <div key={s.instance_pk} className="flex items-center justify-between text-sm">
                    <span className="truncate text-[#1E293B] cursor-pointer hover:text-blue-600"
                      onClick={() => navigate(`/cluster/${s.instance_pk}`)}>
                      {s.display_name}
                    </span>
                    <span className={`font-mono font-semibold ml-2 flex-shrink-0 ${Number(s.hit_ratio) < 90 ? 'text-red-600' : 'text-amber-600'}`}>
                      {Number(s.hit_ratio)}% hit
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {alertSummary.length > 0 && (
            <div className="bg-white rounded-lg shadow-sm p-4">
              <div className="text-xs font-semibold text-[#64748B] mb-3 uppercase tracking-wide">
                Açık Alert Özeti
              </div>
              <div className="grid grid-cols-2 gap-2">
                {alertSummary.map(a => (
                  <div key={a.severity} className="text-center p-2 rounded-lg bg-[#F8FAFC]">
                    <div className={`text-lg font-bold ${a.severity === 'emergency' ? 'text-red-700' :
                      a.severity === 'critical' ? 'text-red-600' :
                        a.severity === 'warning' ? 'text-amber-600' : 'text-blue-600'
                      }`}>{Number(a.count)}</div>
                    <div className="text-[10px] text-[#64748B] uppercase">{a.severity}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Instance ara..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="border border-[#E2E8F0] rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6] w-44"
        />

        {environments.length > 1 && (
          <select
            value={envFilter}
            onChange={e => setEnvFilter(e.target.value)}
            className="border border-[#E2E8F0] rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6] bg-white"
          >
            <option value="">Tüm Ortamlar</option>
            {environments.map(env => (
              <option key={env} value={env}>{env}</option>
            ))}
          </select>
        )}

        <select
          value={stateFilter}
          onChange={e => setStateFilter(e.target.value)}
          className="border border-[#E2E8F0] rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6] bg-white"
        >
          <option value="">Tüm Durumlar</option>
          <option value="ready">Hazır</option>
          <option value="degraded">Degraded</option>
          <option value="bootstrapping">Bootstrap</option>
          <option value="pending">Bekliyor</option>
          <option value="issues">Sorunlu</option>
        </select>

        {filtered.length !== instances.length && (
          <span className="text-xs text-[#94A3B8]">
            {filtered.length} / {instances.length} instance
          </span>
        )}

        <div className="flex items-center gap-1.5 ml-auto">
          <span className="text-xs text-[#64748B]">Grupla:</span>
          <button
            onClick={() => setGroupBy(g => g === 'environment' ? 'none' : 'environment')}
            className={`text-xs px-2.5 py-1.5 rounded-md border transition-colors ${groupBy === 'environment'
              ? 'bg-[#3B82F6] text-white border-[#3B82F6]'
              : 'bg-white text-[#64748B] border-[#E2E8F0] hover:border-[#CBD5E1]'
              }`}
          >
            Ortama Göre
          </button>
        </div>
      </div>

      {/* Instance grid */}
      {health.isLoading ? (
        <div className="text-[#94A3B8] text-sm py-10 text-center">Yükleniyor...</div>
      ) : filtered.length === 0 ? (
        <div className="text-[#94A3B8] text-sm py-10 text-center">
          {instances.length === 0
            ? 'Henüz instance eklenmemiş.'
            : 'Filtreyle eşleşen instance bulunamadı.'}
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(group => (
            <div key={group.key}>
              {groupBy === 'environment' && (
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                    {group.label}
                  </h3>
                  <span className="text-xs text-[#94A3B8]">({group.items.length})</span>
                  <div className="flex-1 h-px bg-[#E2E8F0]" />
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                {group.items.map(inst => renderTile(inst))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
