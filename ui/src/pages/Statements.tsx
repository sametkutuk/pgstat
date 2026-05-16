import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiGet } from '../api/client';
import { useState, useMemo, useEffect } from 'react';
import PrintButton from '../components/common/PrintButton';
import { SkeletonTable } from '../components/common/Skeleton';
import EmptyState from '../components/common/EmptyState';
import StatementColumnsModal, { useStatementColumns, fmtStmtValue } from '../components/statements/StatementColumnsModal';
import StatementSqlCell from '../components/statements/StatementSqlCell';
import ResizableTh, { useColumnWidths, toggleSort, sortKeysToParam, type SortKey } from '../components/statements/ResizableTh';

// Dinamik kolon destegi — Statement satiri Record<string, any> olarak gelir.
// Sabit alanlar (instance_name, datname, queryid, query_text_short, query_text_id)
// her zaman doner; metric kolonlari kullanicinin secimine gore.
interface Statement {
  statement_series_id: number;
  instance_pk: number;
  instance_name: string;
  datname: string | null;
  rolname: string | null;
  queryid: string | null;
  query_text_id: number | null;
  query_text_short: string | null;
  no_delta_data?: boolean;
  // Metric kolonlari index ile erisilir (number, kullanici secimine bagli)
  [key: string]: any;
}

interface Instance {
  instance_pk: number;
  display_name: string;
  host: string;
  port: number;
}


export default function Statements() {
  const navigate = useNavigate();

  const [hours, setHours] = useState(1);
  const [sortKeys, setSortKeys] = useState<SortKey[]>([{ col: 'total_exec_time_ms', dir: 'desc' }]);
  const orderParam = sortKeysToParam(sortKeys);
  const sortToggle = (col: string, additive: boolean) => setSortKeys(prev => toggleSort(prev, col, additive));
  const [instancePk, setInstancePk] = useState('');
  const [columnsModalOpen, setColumnsModalOpen] = useState(false);

  // Kullanici secimi kolonlar (LocalStorage) + meta (API'den)
  const { selected: selectedCols, setSelected: setSelectedCols, meta: colsMeta } = useStatementColumns();
  const { widths, setWidth, reset: resetWidths } = useColumnWidths('pgstat.statements.widths');
  const [datname, setDatname] = useState('');
  const [rolname, setRolname] = useState('');
  const [sqlSearch, setSqlSearch] = useState('');
  const [minAvgMs, setMinAvgMs] = useState('');

  const instances = useQuery({
    queryKey: ['instances-list'],
    queryFn: () => apiGet<Instance[]>('/instances'),
    staleTime: 60_000,
  });

  // 1) Top statements (fact.pgss_delta) — secili kolonlar dinamik gonderilir
  const topParams = new URLSearchParams({
    hours: String(hours),
    limit: '100',
    order_by: orderParam,
    columns: selectedCols.join(','),
    ...(instancePk ? { instance_pk: instancePk } : {}),
    ...(datname ? { datname } : {}),
    ...(rolname ? { rolname } : {}),
  });

  const { data: topData, isLoading: topLoading, isFetching, refetch } = useQuery({
    queryKey: ['top-statements', hours, orderParam, instancePk, datname, rolname, selectedCols.join(',')],
    queryFn: () => apiGet<Statement[]>(`/statements/top?${topParams}`),
    refetchInterval: 30_000,
  });

  // Secili kolonlar degisirse sort kriterlerinden secili olmayanlari at
  useEffect(() => {
    setSortKeys(prev => {
      const filtered = prev.filter(s => selectedCols.includes(s.col));
      if (filtered.length > 0) return filtered;
      const fallback = selectedCols.includes('total_exec_time_ms') ? 'total_exec_time_ms' : selectedCols[0];
      return [{ col: fallback, dir: 'desc' }];
    });
  }, [selectedCols]);

  // 2) Deep search (dim.statement_series) — 3+ karakter yazıldığında otomatik
  const searchTrimmed = sqlSearch.trim();
  const deepSearchEnabled = searchTrimmed.length >= 3;

  const deepParams = new URLSearchParams({
    q: searchTrimmed,
    limit: '50',
    ...(instancePk ? { instance_pk: instancePk } : {}),
  });

  const { data: deepData, isLoading: deepLoading } = useQuery({
    queryKey: ['deep-search', searchTrimmed, instancePk],
    queryFn: () => apiGet<Statement[]>(`/statements/search?${deepParams}`),
    enabled: deepSearchEnabled,
  });

  // Sonuçları birleştir: top statements + deep search (duplicate'leri çıkar)
  const merged = useMemo(() => {
    const topRows = topData ?? [];
    if (!deepSearchEnabled || !deepData) return topRows;

    // Client-side filtre: top results'ta arama
    const q = searchTrimmed.toLowerCase();
    const topFiltered = topRows.filter(r =>
      (r.query_text_short ?? '').toLowerCase().includes(q)
    );

    // Deep search'ten gelen ama top'ta olmayan satırları ekle
    const topIds = new Set(topFiltered.map(r => r.statement_series_id));
    const extras = deepData.filter(r => !topIds.has(r.statement_series_id));

    return [...topFiltered, ...extras];
  }, [topData, deepData, searchTrimmed, deepSearchEnabled]);

  // Client-side filtreler (arama + min avg)
  const filtered = useMemo(() => {
    const minMs = parseFloat(minAvgMs) || 0;
    const q = searchTrimmed.toLowerCase();

    return merged.filter(r => {
      // Deep search aktifse zaten filtrelenmiş, değilse client-side filtrele
      if (q && !deepSearchEnabled && !(r.query_text_short ?? '').toLowerCase().includes(q)) return false;
      // mean_exec_time_ms artik secili kolonlardan birinde varsa filtre uygulanir
      if (minMs > 0) {
        const mean = Number(r.mean_exec_time_ms ?? r.avg_exec_time_ms ?? 0);
        if (mean < minMs) return false;
      }
      return true;
    });
  }, [merged, searchTrimmed, minAvgMs, deepSearchEnabled]);

  const datnames = useMemo(() => {
    const s = new Set((topData ?? []).map(r => r.datname).filter(Boolean) as string[]);
    return Array.from(s).sort();
  }, [topData]);

  const rolnames = useMemo(() => {
    const s = new Set((topData ?? []).map(r => r.rolname).filter(Boolean) as string[]);
    return Array.from(s).sort();
  }, [topData]);

  const hasFilter = instancePk || datname || rolname || sqlSearch || minAvgMs;
  const isLoading = topLoading;

  function clearFilters() {
    setInstancePk(''); setDatname(''); setRolname('');
    setSqlSearch(''); setMinAvgMs('');
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold">Top Statements</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setColumnsModalOpen(true)}
            className="text-xs text-[#64748B] hover:text-[#1E293B] px-3 py-1.5 border border-[#E2E8F0] rounded-md hover:border-[#CBD5E1] transition-colors print:hidden"
            title="Görmek istediğiniz kolonları seçin">
            ⚙️ Sütun Yönet ({selectedCols.length})
          </button>
          <button onClick={resetWidths}
            className="text-xs text-[#64748B] hover:text-[#1E293B] px-3 py-1.5 border border-[#E2E8F0] rounded-md hover:border-[#CBD5E1] transition-colors print:hidden"
            title="Kolon genişliklerini varsayılana döndür">
            ↔ Genişlik sıfırla
          </button>
          <PrintButton title="Top Statements" />
          <button
            onClick={() => refetch()}
            className="text-xs text-[#64748B] hover:text-[#1E293B] px-3 py-1.5 border border-[#E2E8F0] rounded-md hover:border-[#CBD5E1] transition-colors print:hidden"
          >
            {isFetching ? 'Yenileniyor...' : 'Yenile'}
          </button>
        </div>
      </div>

      {/* Filtre çubuğu */}
      <div className="bg-white rounded-lg shadow-sm p-4 mb-4 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-[#64748B] mb-1">Zaman Aralığı</label>
            <select value={hours} onChange={e => setHours(Number(e.target.value))}
              className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white">
              <option value={1}>Son 1 saat</option>
              <option value={6}>Son 6 saat</option>
              <option value={24}>Son 24 saat</option>
              <option value={72}>Son 3 gün</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-[#64748B] mb-1">Instance</label>
            <select value={instancePk} onChange={e => { setInstancePk(e.target.value); setDatname(''); }}
              className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[180px]">
              <option value="">Tüm Instance'lar</option>
              {(instances.data ?? []).map(i => (
                <option key={i.instance_pk} value={i.instance_pk}>{i.display_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-[#64748B] mb-1">Database</label>
            <select value={datname} onChange={e => setDatname(e.target.value)}
              className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[140px]">
              <option value="">Tüm DB'ler</option>
              {datnames.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-[#64748B] mb-1">Rol</label>
            <select value={rolname} onChange={e => setRolname(e.target.value)}
              className="border border-[#E2E8F0] rounded px-3 py-1.5 text-sm bg-white min-w-[120px]">
              <option value="">Tüm Roller</option>
              {rolnames.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-[#64748B] mb-1">
              SQL Ara {deepSearchEnabled && deepLoading ? '(aranıyor...)' : deepSearchEnabled ? '(tüm sorgularda)' : ''}
            </label>
            <input type="text" placeholder="örn: pg_stat_statements_hstr, SELECT users..."
              value={sqlSearch} onChange={e => setSqlSearch(e.target.value)}
              className="w-full border border-[#E2E8F0] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6]" />
          </div>
          <div>
            <label className="block text-xs text-[#64748B] mb-1">Min Ort. Süre (ms)</label>
            <input type="number" placeholder="0" value={minAvgMs}
              onChange={e => setMinAvgMs(e.target.value)} min={0}
              className="w-32 border border-[#E2E8F0] rounded px-3 py-1.5 text-sm focus:outline-none focus:border-[#3B82F6]" />
          </div>
          <div className="flex items-end gap-3">
            {hasFilter && (
              <button onClick={clearFilters}
                className="px-3 py-1.5 text-sm text-[#64748B] border border-[#E2E8F0] rounded hover:bg-[#F8FAFC] transition-colors">
                ✕ Temizle
              </button>
            )}
            <span className="text-xs text-[#94A3B8] pb-1">
              {isLoading ? '…' : `${filtered.length} sorgu`}
            </span>
          </div>
        </div>
      </div>

      {/* Tablo */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {isLoading ? (
          <SkeletonTable rows={8} cols={6} />
        ) : filtered.length === 0 ? (
          <EmptyState icon="🔍" title={sqlSearch.length >= 3 && !deepLoading ? 'Eşleşen sorgu yok' : 'Statement verisi yok'}
            description={sqlSearch.length >= 3 && !deepLoading
              ? 'Farklı bir arama terimi deneyin veya zaman aralığını genişletin.'
              : 'Bu aralıkta pg_stat_statements verisi toplanmamış. Zaman aralığını genişletmeyi deneyin.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                  <ResizableTh colKey="instance" width={widths['instance'] ?? 140} onResize={setWidth}
                    className="py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Instance</ResizableTh>
                  <ResizableTh colKey="db_rol" width={widths['db_rol'] ?? 140} onResize={setWidth}
                    className="py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">DB / Rol</ResizableTh>
                  <ResizableTh colKey="queryid" width={widths['queryid'] ?? 130} onResize={setWidth}
                    className="py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Query ID</ResizableTh>
                  <ResizableTh colKey="sql" width={widths['sql'] ?? 360} onResize={setWidth}
                    className="py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">SQL</ResizableTh>
                  {selectedCols.map(col => {
                    const meta = colsMeta?.available.find(c => c.key === col);
                    return (
                      <ResizableTh key={col} colKey={col} width={widths[col] ?? 120} onResize={setWidth} align="right"
                        sortKeys={sortKeys} onSortToggle={sortToggle}
                        className="py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">
                        {meta?.label ?? col}
                        {meta && meta.since > 11 && (
                          <span className="ml-1 text-[9px] font-normal text-[#94A3B8]">PG{meta.since}+</span>
                        )}
                      </ResizableTh>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const meanMs = Number(r.mean_exec_time_ms ?? 0);
                  return (
                    <tr key={r.statement_series_id}
                      onClick={() => navigate(`/statements/${r.statement_series_id}`)}
                      className={`border-b border-[#F1F5F9] hover:bg-[#F8FAFC] cursor-pointer transition-colors ${r.no_delta_data ? 'opacity-60' : ''}`}>
                      <td className="py-2.5 px-3 text-xs text-[#64748B] whitespace-nowrap">{r.instance_name}</td>
                      <td className="py-2.5 px-3 text-xs whitespace-nowrap">
                        <div className="text-[#1E293B]">{r.datname ?? '—'}</div>
                        <div className="text-[#94A3B8]">{r.rolname ?? '—'}</div>
                      </td>
                      <td className="py-2.5 px-3 text-xs font-mono text-[#94A3B8] whitespace-nowrap">
                        {r.queryid ? String(r.queryid) : '—'}
                      </td>
                      <td className="py-2.5 px-3 max-w-sm">
                        <StatementSqlCell
                          queryTextId={r.query_text_id ?? null}
                          short={r.query_text_short ?? null}
                          showDeltaBadge={!!r.no_delta_data}
                        />
                      </td>
                      {selectedCols.map(col => {
                        const v = r[col];
                        // mean_exec_time icin renklendirme
                        let cls = 'text-[#64748B]';
                        if (col === 'mean_exec_time_ms') {
                          cls = meanMs >= 1000 ? 'text-red-600 font-semibold'
                            : meanMs >= 100 ? 'text-amber-600 font-semibold' : 'text-[#64748B]';
                        }
                        if (col === 'total_temp_blks_written' && Number(v) > 0) {
                          cls = 'text-amber-600 font-semibold';
                        }
                        return (
                          <td key={col} className={`py-2.5 px-3 text-right font-mono text-xs whitespace-nowrap ${cls}`}>
                            {fmtStmtValue(col, v)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <StatementColumnsModal
        open={columnsModalOpen}
        onClose={() => setColumnsModalOpen(false)}
        selected={selectedCols}
        onChange={setSelectedCols}
        meta={colsMeta}
      />
    </div>
  );
}
