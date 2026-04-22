import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../api/client';
import { useState, useMemo } from 'react';

interface Statement {
  statement_series_id: number;
  instance_pk: number;
  instance_name: string;
  datname: string | null;
  rolname: string | null;
  query_text_short: string | null;
  total_calls: number;
  total_exec_time_ms: number;
  avg_exec_time_ms: number;
  total_rows: number;
  total_shared_blks_read: number;
  total_temp_blks_written: number;
}

interface Instance {
  instance_pk: number;
  display_name: string;
  host: string;
  port: number;
}

const ORDER_OPTIONS = [
  { v: 'exec_time', l: 'Toplam Süre' },
  { v: 'avg_time',  l: 'Ort. Süre' },
  { v: 'calls',     l: 'Çağrı Sayısı' },
  { v: 'rows',      l: 'Satır Sayısı' },
  { v: 'blks_read', l: 'Blok Okuma' },
  { v: 'temp_blks', l: 'Temp Blok' },
];

function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}dk`;
  if (ms >= 1_000)  return `${(ms / 1_000).toFixed(2)}s`;
  return `${ms.toFixed(1)}ms`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

export default function Statements() {
  const navigate = useNavigate();

  // Server-side filtreler
  const [hours, setHours]           = useState(1);
  const [orderBy, setOrderBy]       = useState('exec_time');
  const [instancePk, setInstancePk] = useState('');
  const [datname, setDatname]       = useState('');
  const [rolname, setRolname]       = useState('');

  // Client-side filtreler
  const [sqlSearch, setSqlSearch]   = useState('');
  const [minAvgMs, setMinAvgMs]     = useState('');

  const instances = useQuery({
    queryKey: ['instances-list'],
    queryFn: () => apiGet<Instance[]>('/instances'),
    staleTime: 60_000,
  });

  const params = new URLSearchParams({
    hours: String(hours),
    limit: '100',
    order_by: orderBy,
    ...(instancePk ? { instance_pk: instancePk } : {}),
    ...(datname    ? { datname }                  : {}),
    ...(rolname    ? { rolname }                  : {}),
  });

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['top-statements', hours, orderBy, instancePk, datname, rolname],
    queryFn: () => apiGet<Statement[]>(`/statements/top?${params}`),
    refetchInterval: 30_000,
  });

  // Benzersiz database ve rol listesi (mevcut sonuçlardan)
  const datnames = useMemo(() => {
    const s = new Set((data ?? []).map(r => r.datname).filter(Boolean) as string[]);
    return Array.from(s).sort();
  }, [data]);

  const rolnames = useMemo(() => {
    const s = new Set((data ?? []).map(r => r.rolname).filter(Boolean) as string[]);
    return Array.from(s).sort();
  }, [data]);

  // Client-side filtre uygula
  const filtered = useMemo(() => {
    const minMs = parseFloat(minAvgMs) || 0;
    const q = sqlSearch.trim().toLowerCase();
    return (data ?? []).filter(r => {
      if (q && !(r.query_text_short ?? '').toLowerCase().includes(q)) return false;
      if (minMs > 0 && Number(r.avg_exec_time_ms) < minMs) return false;
      return true;
    });
  }, [data, sqlSearch, minAvgMs]);

  const hasFilter = instancePk || datname || rolname || sqlSearch || minAvgMs;

  function clearFilters() {
    setInstancePk(''); setDatname(''); setRolname('');
    setSqlSearch(''); setMinAvgMs('');
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold">Top Statements</h1>
        <button
          onClick={() => refetch()}
          className="text-xs text-[#64748B] hover:text-[#1E293B] px-3 py-1.5 border border-[#E2E8F0] rounded-md hover:border-[#CBD5E1] transition-colors"
        >
          {isFetching ? 'Yenileniyor...' : 'Yenile'}
        </button>
      </div>

      {/* Filtre çubuğu */}
      <div className="bg-white rounded-lg shadow-sm p-4 mb-4 space-y-3">
        {/* Satır 1: zaman + sıralama + instance */}
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-[#64748B] mb-1">Zaman Aralığı</label>
            <select
              value={hours}
              onChange={e => setHours(Number(e.target.value))}
              className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white"
            >
              <option value={1}>Son 1 saat</option>
              <option value={6}>Son 6 saat</option>
              <option value={24}>Son 24 saat</option>
              <option value={72}>Son 3 gün</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-[#64748B] mb-1">Sıralama</label>
            <select
              value={orderBy}
              onChange={e => setOrderBy(e.target.value)}
              className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white"
            >
              {ORDER_OPTIONS.map(o => (
                <option key={o.v} value={o.v}>{o.l}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-[#64748B] mb-1">Instance</label>
            <select
              value={instancePk}
              onChange={e => { setInstancePk(e.target.value); setDatname(''); }}
              className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[180px]"
            >
              <option value="">Tüm Instance'lar</option>
              {(instances.data ?? []).map(i => (
                <option key={i.instance_pk} value={i.instance_pk}>
                  {i.display_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-[#64748B] mb-1">Database</label>
            <select
              value={datname}
              onChange={e => setDatname(e.target.value)}
              className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[140px]"
            >
              <option value="">Tüm DB'ler</option>
              {datnames.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs text-[#64748B] mb-1">Rol</label>
            <select
              value={rolname}
              onChange={e => setRolname(e.target.value)}
              className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[120px]"
            >
              <option value="">Tüm Roller</option>
              {rolnames.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>

        {/* Satır 2: SQL arama + min avg süre */}
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-[#64748B] mb-1">SQL Metni Ara</label>
            <input
              type="text"
              placeholder="örn: SELECT, update users, pg_stat..."
              value={sqlSearch}
              onChange={e => setSqlSearch(e.target.value)}
              className="w-full border border-[#E2E8F0] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6]"
            />
          </div>

          <div>
            <label className="block text-xs text-[#64748B] mb-1">Min Ort. Süre (ms)</label>
            <input
              type="number"
              placeholder="0"
              value={minAvgMs}
              onChange={e => setMinAvgMs(e.target.value)}
              min={0}
              className="w-32 border border-[#E2E8F0] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6]"
            />
          </div>

          <div className="flex items-end gap-3">
            {hasFilter && (
              <button
                onClick={clearFilters}
                className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC] transition-colors"
              >
                ✕ Temizle
              </button>
            )}
            <span className="text-xs text-[#94A3B8] pb-1">
              {isLoading ? '…' : (
                hasFilter && filtered.length !== (data?.length ?? 0)
                  ? `${filtered.length} / ${data?.length ?? 0} sorgu`
                  : `${filtered.length} sorgu`
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Tablo */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="text-[#94A3B8] py-10 text-center text-sm">Yükleniyor...</div>
        ) : filtered.length === 0 ? (
          <div className="text-[#94A3B8] py-10 text-center text-sm">
            {data?.length === 0 ? 'Bu aralıkta statement verisi yok.' : 'Filtreyle eşleşen sorgu bulunamadı.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                  <th className="text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Instance</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">DB / Rol</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">SQL</th>
                  <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Calls</th>
                  <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Toplam Süre</th>
                  <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Ort. Süre</th>
                  <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Rows</th>
                  <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Blks Read</th>
                  <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Temp Blks</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const avgMs = Number(r.avg_exec_time_ms);
                  const avgColor = avgMs >= 1000 ? 'text-red-600 font-semibold'
                    : avgMs >= 100 ? 'text-amber-600 font-semibold'
                    : 'text-[#64748B]';
                  return (
                    <tr
                      key={r.statement_series_id}
                      onClick={() => navigate(`/statements/${r.statement_series_id}`)}
                      className="border-b border-[#F1F5F9] hover:bg-[#F8FAFC] cursor-pointer transition-colors"
                    >
                      <td className="py-2.5 px-3 text-xs text-[#64748B]">{r.instance_name}</td>
                      <td className="py-2.5 px-3 text-xs">
                        <div className="text-[#1E293B]">{r.datname ?? '—'}</div>
                        <div className="text-[#94A3B8]">{r.rolname ?? '—'}</div>
                      </td>
                      <td className="py-2.5 px-3 max-w-sm">
                        <div
                          className="truncate text-xs font-mono text-[#1E293B]"
                          title={r.query_text_short ?? ''}
                        >
                          {r.query_text_short || <span className="text-[#94A3B8] italic">metin yok</span>}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-xs text-[#64748B]">
                        {fmtNum(Number(r.total_calls))}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-xs text-[#64748B]">
                        {fmtMs(Number(r.total_exec_time_ms))}
                      </td>
                      <td className={`py-2.5 px-3 text-right font-mono text-xs ${avgColor}`}>
                        {fmtMs(avgMs)}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-xs text-[#64748B]">
                        {fmtNum(Number(r.total_rows))}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-xs text-[#64748B]">
                        {fmtNum(Number(r.total_shared_blks_read))}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono text-xs">
                        {Number(r.total_temp_blks_written) > 0
                          ? <span className="text-amber-600 font-semibold">{fmtNum(Number(r.total_temp_blks_written))}</span>
                          : <span className="text-[#94A3B8]">0</span>
                        }
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
