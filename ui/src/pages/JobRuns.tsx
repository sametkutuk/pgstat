import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import Badge from '../components/common/Badge';

interface JobRun {
  job_run_id: number;
  job_type: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  rows_written: number;
  instances_succeeded: number;
  instances_failed: number;
  worker_hostname: string;
  error_text: string | null;
}

interface JobStat {
  job_type: string;
  total_runs: number;
  success_count: number;
  failed_count: number;
  partial_count: number;
  avg_duration_seconds: number;
  total_rows_written: number;
}

const JOB_TYPE_LABELS: Record<string, string> = {
  cluster: 'Cluster Metrikleri',
  statements: 'Statement Analizi',
  db_objects: 'DB Nesneleri',
  rollup: 'Rollup / Arşiv',
};

function jobLabel(t: string) {
  return JOB_TYPE_LABELS[t] ?? t;
}

function duration(r: JobRun): string {
  if (!r.finished_at) {
    const sec = Math.round((Date.now() - new Date(r.started_at).getTime()) / 1000);
    return `${sec}s…`;
  }
  const ms = new Date(r.finished_at).getTime() - new Date(r.started_at).getTime();
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}dk ${Math.round(sec % 60)}s`;
}

export default function JobRuns() {
  const [jobType, setJobType] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  function toggleExpand(id: number) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Tip veya durum filtresi değişince expand'ları sıfırla
  function applyJobType(t: string) { setJobType(t); setExpandedIds(new Set()); }
  function applyStatus(s: string) { setStatusFilter(s); setExpandedIds(new Set()); }

  // Hata filtresine tıklayınca hem tip hem durum set et
  function filterToFailed(type: string) {
    setJobType(type);
    setStatusFilter('failed');
    setExpandedIds(new Set());
  }

  const stats = useQuery({
    queryKey: ['job-stats'],
    queryFn: () => apiGet<JobStat[]>('/job-runs/stats'),
    refetchInterval: 30_000,
  });

  // Tümü: her tipten son 5 (max 20 satır). Spesifik tip veya durum: o tipin son 50'si.
  const runs = useQuery({
    queryKey: ['job-runs', jobType, statusFilter],
    queryFn: () => {
      const hasFilter = jobType || statusFilter;
      const base = hasFilter
        ? `/job-runs?limit=50${jobType ? `&job_type=${jobType}` : ''}${statusFilter ? `&status=${statusFilter}` : ''}`
        : `/job-runs?per_type=5`;
      return apiGet<JobRun[]>(base);
    },
    refetchInterval: 15_000,
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <h1 className="text-xl font-bold">Job Runs</h1>
        <button
          onClick={() => runs.refetch()}
          className="text-xs text-[#64748B] hover:text-[#1E293B] px-3 py-1.5 border border-[#E2E8F0] rounded-md hover:border-[#CBD5E1] transition-colors"
        >
          {runs.isFetching ? 'Yenileniyor...' : 'Yenile'}
        </button>
      </div>

      {/* İstatistik kartları */}
      {stats.data && stats.data.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
          {stats.data.map((s) => {
            const total = Number(s.total_runs);
            const success = Number(s.success_count);
            const failed = Number(s.failed_count);
            const partial = Number(s.partial_count);
            const successRate = total > 0 ? Math.round((success / total) * 100) : 100;
            const isActive = jobType === s.job_type;
            return (
              <div
                key={s.job_type}
                onClick={() => applyJobType(isActive ? '' : s.job_type)}
                className={`bg-white rounded-lg p-4 shadow-sm cursor-pointer transition-all border-2 ${isActive ? 'border-[#3B82F6]' : 'border-transparent hover:border-[#E2E8F0]'}`}
              >
                <div className="text-xs font-semibold text-[#64748B] mb-2">{jobLabel(s.job_type)}</div>
                <div className="flex items-baseline gap-1.5 mb-2">
                  <span className="text-xl font-bold text-[#1E293B]">{total}</span>
                  <span className="text-xs text-[#94A3B8]">çalışma</span>
                </div>
                {/* Başarı oranı çubuğu */}
                <div className="w-full h-1.5 bg-[#F1F5F9] rounded-full mb-2">
                  <div
                    className={`h-1.5 rounded-full ${successRate === 100 ? 'bg-green-500' : successRate >= 80 ? 'bg-amber-500' : 'bg-red-500'}`}
                    style={{ width: `${successRate}%` }}
                  />
                </div>
                <div className="flex gap-2 text-xs">
                  <span className="text-green-600">{success}✓</span>
                  {failed > 0 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); filterToFailed(s.job_type); }}
                      className="text-red-600 font-semibold underline decoration-dotted hover:text-red-800"
                      title="Hatalı çalışmaları filtrele"
                    >
                      {failed}✗
                    </button>
                  )}
                  {partial > 0 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setJobType(s.job_type); setStatusFilter('partial'); setExpandedIds(new Set()); }}
                      className="text-amber-600 font-semibold underline decoration-dotted hover:text-amber-800"
                      title="Kısmi başarılı çalışmaları filtrele"
                    >
                      {partial}⚠
                    </button>
                  )}
                  <span className="text-[#94A3B8] ml-auto">ort {Number(s.avg_duration_seconds).toFixed(1)}s</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Filtreler */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {/* Tip filtresi */}
        {['', 'cluster', 'statements', 'db_objects', 'rollup'].map((t) => (
          <button
            key={t}
            onClick={() => applyJobType(t)}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${jobType === t && !statusFilter
              ? 'bg-[#3B82F6] text-white'
              : 'bg-white text-[#64748B] border border-[#E2E8F0] hover:bg-[#F8FAFC]'
              }`}
          >
            {t ? jobLabel(t) : 'Tümü'}
          </button>
        ))}

        <div className="w-px h-5 bg-[#E2E8F0] mx-1" />

        {/* Durum filtresi */}
        {[
          { v: '', l: 'Tüm Durumlar' },
          { v: 'success', l: '✓ Başarılı' },
          { v: 'failed', l: '✗ Hatalı' },
          { v: 'partial', l: '⚠ Kısmi' },
        ].map(({ v, l }) => (
          <button
            key={v}
            onClick={() => applyStatus(v)}
            className={`px-3 py-1.5 text-sm rounded transition-colors ${statusFilter === v
              ? v === 'failed' ? 'bg-red-500 text-white'
              : v === 'partial' ? 'bg-amber-500 text-white'
              : v === 'success' ? 'bg-green-600 text-white'
              : 'bg-[#3B82F6] text-white'
              : 'bg-white text-[#64748B] border border-[#E2E8F0] hover:bg-[#F8FAFC]'
              }`}
          >
            {l}
          </button>
        ))}

        {(jobType || statusFilter) && (
          <button
            onClick={() => { applyJobType(''); applyStatus(''); }}
            className="text-xs text-[#94A3B8] hover:text-[#64748B] ml-1"
          >
            ✕ Filtreyi temizle
          </button>
        )}

        <span className="text-xs text-[#94A3B8] ml-auto">
          {(jobType || statusFilter) ? `Son 50 çalışma` : 'Her tipten son 5 çalışma'}
        </span>
      </div>

      {/* Tablo */}
      <div className="bg-white rounded-lg shadow-sm overflow-hidden">
        {runs.isLoading ? (
          <div className="text-[#94A3B8] py-10 text-center text-sm">Yükleniyor...</div>
        ) : !runs.data?.length ? (
          <div className="text-[#94A3B8] py-10 text-center text-sm">Job kaydı bulunamadı.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2E8F0] bg-[#F8FAFC]">
                  <th className="w-8 py-3 px-3" />
                  <th className="text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Durum</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Job Tipi</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Başlangıç</th>
                  <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Süre</th>
                  <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Satır</th>
                  <th className="text-right py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Instance</th>
                  <th className="text-left py-3 px-3 text-xs font-semibold text-[#64748B] uppercase tracking-wide">Hata</th>
                </tr>
              </thead>
              <tbody>
                {runs.data.map((r) => {
                  const expanded = expandedIds.has(r.job_run_id);
                  const isRunning = !r.finished_at;
                  return (
                    <Fragment key={r.job_run_id}>
                      <tr
                        onClick={() => toggleExpand(r.job_run_id)}
                        className={`border-b border-[#F1F5F9] cursor-pointer transition-colors ${expanded ? 'bg-blue-50' : 'hover:bg-[#F8FAFC]'}`}
                      >
                        {/* Expand toggle */}
                        <td className="py-2.5 px-3 text-[#94A3B8]">
                          <span className="inline-block transition-transform text-xs" style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}>
                            ▶
                          </span>
                        </td>
                        <td className="py-2.5 px-3">
                          <Badge value={isRunning ? 'running' : r.status} />
                        </td>
                        <td className="py-2.5 px-3 font-medium text-[#1E293B]">
                          {jobLabel(r.job_type)}
                        </td>
                        <td className="py-2.5 px-3 text-[#64748B] text-xs">
                          <div>{new Date(r.started_at).toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit' })}</div>
                          <div className="font-mono">{new Date(r.started_at).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
                        </td>
                        <td className={`py-2.5 px-3 text-right font-mono text-xs ${isRunning ? 'text-blue-600' : 'text-[#64748B]'}`}>
                          {duration(r)}
                        </td>
                        <td className="py-2.5 px-3 text-right text-[#64748B] font-mono text-xs">
                          {Number(r.rows_written).toLocaleString()}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <span className="text-green-600">{r.instances_succeeded}✓</span>
                          {r.instances_failed > 0 && (
                            <span className="text-red-600 ml-1">{r.instances_failed}✗</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-xs text-red-500 max-w-xs">
                          {r.error_text ? (
                            <span className="truncate block max-w-[200px]" title={r.error_text}>
                              {r.error_text}
                            </span>
                          ) : '—'}
                        </td>
                      </tr>

                      {/* Inline expand: instance detayları */}
                      {expanded && (
                        <tr className="border-b border-[#E2E8F0]">
                          <td colSpan={8} className="p-0">
                            <JobInstancesInline jobRunId={r.job_run_id} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
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

function JobInstancesInline({ jobRunId }: { jobRunId: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['job-run-instances', jobRunId],
    queryFn: () => apiGet<any[]>(`/job-runs/${jobRunId}/instances`),
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="px-8 py-3 text-xs text-[#94A3B8] bg-[#F8FAFC]">Yükleniyor...</div>
    );
  }

  if (!data?.length) {
    return (
      <div className="px-8 py-3 text-xs text-[#94A3B8] bg-[#F8FAFC]">Instance kaydı yok.</div>
    );
  }

  return (
    <div className="bg-[#F8FAFC] px-8 py-3">
      <div className="text-xs font-semibold text-[#64748B] mb-2 uppercase tracking-wide">
        Instance Detayları — Job #{jobRunId}
      </div>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-[#E2E8F0]">
            <th className="text-left py-1.5 pr-4 text-[#94A3B8] font-medium">Instance</th>
            <th className="text-left py-1.5 pr-4 text-[#94A3B8] font-medium">Durum</th>
            <th className="text-right py-1.5 pr-4 text-[#94A3B8] font-medium">Satır</th>
            <th className="text-right py-1.5 pr-4 text-[#94A3B8] font-medium">Yeni Seri</th>
            <th className="text-right py-1.5 pr-4 text-[#94A3B8] font-medium">Yeni Text</th>
            <th className="text-right py-1.5 pr-4 text-[#94A3B8] font-medium">Süre</th>
            <th className="text-left py-1.5 text-[#94A3B8] font-medium">Hata</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r: any) => {
            const dur = r.finished_at && r.started_at
              ? `${((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1)}s`
              : '—';
            return (
              <tr key={r.job_run_instance_id} className="border-b border-[#F1F5F9] last:border-0">
                <td className="py-1.5 pr-4 font-medium text-[#1E293B]">
                  {r.display_name || r.instance_pk}
                  <span className="text-[#94A3B8] font-normal ml-1">
                    {r.host}:{r.port}
                  </span>
                </td>
                <td className="py-1.5 pr-4"><Badge value={r.status} /></td>
                <td className="py-1.5 pr-4 text-right font-mono">{Number(r.rows_written).toLocaleString()}</td>
                <td className="py-1.5 pr-4 text-right font-mono">{r.new_series_count ?? '—'}</td>
                <td className="py-1.5 pr-4 text-right font-mono">{r.new_query_text_count ?? '—'}</td>
                <td className="py-1.5 pr-4 text-right font-mono text-[#64748B]">{dur}</td>
                <td className="py-1.5 text-red-500 max-w-xs">
                  {r.error_text ? (
                    <span className="block truncate max-w-[300px]" title={r.error_text}>
                      {r.error_text}
                    </span>
                  ) : (
                    <span className="text-[#94A3B8]">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
