import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, apiDelete } from '../api/client';
import DataTable from '../components/common/DataTable';
import Badge from '../components/common/Badge';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { useToast } from '../components/common/Toast';
import { useState } from 'react';

export default function Settings() {
    const [tab, setTab] = useState<'retention' | 'schedule' | 'templates'>('retention');
    const tabs = [
        { key: 'retention' as const, label: 'Retention Politikaları' },
        { key: 'schedule' as const, label: 'Zamanlama Profilleri' },
        { key: 'templates' as const, label: 'Alert Mesaj Şablonları' },
    ];

    return (
        <div>
            <h1 className="text-xl font-bold mb-5">Ayarlar</h1>
            <div className="flex gap-1 mb-4 border-b border-[#E2E8F0]">
                {tabs.map((t) => (
                    <button key={t.key} onClick={() => setTab(t.key)}
                        className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t.key ? 'border-[#3B82F6] text-[#3B82F6]' : 'border-transparent text-[#64748B] hover:text-[#1E293B]'}`}>
                        {t.label}
                    </button>
                ))}
            </div>
            {tab === 'retention' && <RetentionTab />}
            {tab === 'schedule' && <ScheduleTab />}
            {tab === 'templates' && <MessageTemplatesTab />}
        </div>
    );
}

// =========================================================================
// Retention Politikaları
// =========================================================================

const emptyRetention = {
    policy_code: '',
    raw_retention_days: 14,
    hourly_retention_days: 60,
    daily_retention_days: 730,
    snapshot_retention_hours: 48,
    purge_enabled: true,
    is_active: true,
};

function RetentionTab() {
    const qc = useQueryClient();
    const toast = useToast();
    const [formMode, setFormMode] = useState<'closed' | 'add' | 'edit'>('closed');
    const [form, setForm] = useState(emptyRetention);
    const [editId, setEditId] = useState<number | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<{ id: number; code: string } | null>(null);

    const { data, isLoading } = useQuery({ queryKey: ['retention-policies'], queryFn: () => apiGet<any[]>('/retention-policies') });

    const addMut = useMutation({
        mutationFn: (d: typeof form) => apiPost('/retention-policies', d),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ['retention-policies'] }); setFormMode('closed'); toast.success('Politika kaydedildi.'); },
        onError: (e: Error) => toast.error('Politika kaydedilemedi: ' + e.message),
    });

    const editMut = useMutation({
        mutationFn: ({ id, data }: { id: number; data: any }) => apiPut(`/retention-policies/${id}`, data),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ['retention-policies'] }); setFormMode('closed'); toast.success('Politika güncellendi.'); },
        onError: (e: Error) => toast.error('Güncellenemedi: ' + e.message),
    });

    const delMut = useMutation({
        mutationFn: (id: number) => apiDelete(`/retention-policies/${id}`),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ['retention-policies'] }); setDeleteTarget(null); toast.success('Politika silindi.'); },
        onError: (e: Error) => toast.error('Silinemedi: ' + e.message),
    });

    const openEdit = (r: any) => {
        setForm({
            policy_code: r.policy_code,
            raw_retention_days:    r.raw_retention_days    ?? (r.raw_retention_months    ?? 14) * 30 / 30 * 1, // fallback
            hourly_retention_days: r.hourly_retention_days ?? (r.hourly_retention_months ?? 6) * 30,
            daily_retention_days:  r.daily_retention_days  ?? (r.daily_retention_months  ?? 24) * 30,
            snapshot_retention_hours: r.snapshot_retention_hours ?? 48,
            purge_enabled: r.purge_enabled,
            is_active: r.is_active,
        });
        setEditId(r.retention_policy_id);
        setFormMode('edit');
    };

    const columns = [
        { key: 'policy_code', header: 'Kod' },
        { key: 'raw_retention_days', header: 'Raw (gün)', className: 'text-right',
            render: (r: any) => r.raw_retention_days ?? (r.raw_retention_months ? r.raw_retention_months * 30 : '-') },
        { key: 'hourly_retention_days', header: 'Hourly (gün)', className: 'text-right',
            render: (r: any) => r.hourly_retention_days ?? (r.hourly_retention_months ? r.hourly_retention_months * 30 : '-') },
        { key: 'daily_retention_days', header: 'Daily (gün)', className: 'text-right',
            render: (r: any) => r.daily_retention_days ?? (r.daily_retention_months ? r.daily_retention_months * 30 : '-') },
        { key: 'snapshot_retention_hours', header: 'Snapshot (saat)', className: 'text-right',
            render: (r: any) => r.snapshot_retention_hours ?? '-' },
        { key: 'purge_enabled', header: 'Purge', render: (r: any) => r.purge_enabled ? '✅' : '❌' },
        { key: 'bound_instances', header: 'Bağlı', render: (r: any) => r.bound_instances, className: 'text-right' },
        { key: 'is_active', header: 'Durum', render: (r: any) => <Badge value={r.is_active ? 'ready' : 'paused'} /> },
        {
            key: 'actions', header: '', render: (r: any) => (
                <div className="flex gap-1">
                    <button onClick={() => openEdit(r)} className="px-2 py-1 text-xs bg-blue-50 text-blue-600 rounded hover:bg-blue-100">Düzenle</button>
                    {Number(r.bound_instances) === 0 ? (
                        <button onClick={() => setDeleteTarget({ id: r.retention_policy_id, code: r.policy_code })} className="px-2 py-1 text-xs text-red-500 hover:text-red-700">Sil</button>
                    ) : (
                        <span className="px-2 py-1 text-xs text-[#94A3B8] cursor-not-allowed" title={`${r.bound_instances} instance bağlı, önce atamaları değiştirin`}>Sil</span>
                    )}
                </div>
            )
        },
    ];

    const numField = (label: string, key: keyof typeof form) => (
        <div>
            <label className="block text-xs text-[#64748B] mb-1">{label}</label>
            <input type="number" value={form[key] as number} onChange={(e) => setForm({ ...form, [key]: parseInt(e.target.value) || 0 })}
                className="w-full border border-[#E2E8F0] rounded px-3 py-2 text-sm" />
        </div>
    );

    return (
        <div>
            <div className="flex justify-end mb-3">
                <button onClick={() => { setFormMode(formMode === 'closed' ? 'add' : 'closed'); setForm(emptyRetention); }}
                    className="px-3 py-1.5 text-sm bg-[#3B82F6] text-white rounded hover:bg-[#2563EB]">
                    {formMode !== 'closed' ? 'Kapat' : '+ Politika Ekle'}
                </button>
            </div>

            {formMode !== 'closed' && (
                <div className="bg-white rounded-lg shadow-sm p-5 mb-4">
                    <h3 className="text-sm font-semibold text-[#64748B] mb-3">{formMode === 'edit' ? 'Politika Düzenle' : 'Yeni Retention Politikası'}</h3>
                    <div className="mb-3 text-xs bg-[#F0F9FF] border border-[#BAE6FD] text-[#0369A1] rounded-md px-3 py-2 space-y-1">
                        <div><b>Raw (gün):</b> fact.* delta tabloları — saniye hassasiyetinde inceleme</div>
                        <div><b>Hourly (gün):</b> agg.pgss_hourly — orta vade trend (saat hassasiyeti)</div>
                        <div><b>Daily (gün):</b> agg.pgss_daily — uzun vade karşılaştırma (gün hassasiyeti)</div>
                        <div><b>Snapshot (saat):</b> pg_activity_snapshot, pg_lock_snapshot gibi çok yoğun büyüyen snapshot tabloları — genelde sadece incident forensic için kullanılır</div>
                    </div>
                    <form onSubmit={(e) => { e.preventDefault(); formMode === 'edit' && editId ? editMut.mutate({ id: editId, data: form }) : addMut.mutate(form); }} className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div>
                            <label className="block text-xs text-[#64748B] mb-1">Kod *</label>
                            <input value={form.policy_code} onChange={(e) => setForm({ ...form, policy_code: e.target.value })}
                                disabled={formMode === 'edit'} placeholder="standard"
                                className="w-full border border-[#E2E8F0] rounded px-3 py-2 text-sm disabled:bg-[#F1F5F9]" />
                        </div>
                        {numField('Raw (gün)',       'raw_retention_days')}
                        {numField('Hourly (gün)',    'hourly_retention_days')}
                        {numField('Daily (gün)',     'daily_retention_days')}
                        {numField('Snapshot (saat)', 'snapshot_retention_hours')}
                        <div className="flex items-center gap-2">
                            <label className="text-xs text-[#64748B]">Purge Aktif</label>
                            <input type="checkbox" checked={form.purge_enabled as boolean} onChange={(e) => setForm({ ...form, purge_enabled: e.target.checked })} />
                        </div>
                        <div className="flex items-center gap-2">
                            <label className="text-xs text-[#64748B]">Aktif</label>
                            <input type="checkbox" checked={form.is_active as boolean} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                        </div>
                        <div className="col-span-full flex gap-2 justify-end">
                            <button type="button" onClick={() => setFormMode('closed')} className="px-3 py-1.5 text-sm border border-[#E2E8F0] rounded">İptal</button>
                            <button type="submit" className="px-3 py-1.5 text-sm bg-[#3B82F6] text-white rounded hover:bg-[#2563EB]">{formMode === 'edit' ? 'Güncelle' : 'Ekle'}</button>
                        </div>
                    </form>
                </div>
            )}

            <div className="bg-white rounded-lg shadow-sm p-4">
                {isLoading ? <div className="text-[#94A3B8] py-8 text-center">Yükleniyor...</div> : <DataTable columns={columns} data={data || []} />}
            </div>

            <ConfirmDialog open={!!deleteTarget} title="Politika Sil"
                message={`"${deleteTarget?.code}" politikasını silmek istediğinize emin misiniz?`}
                onConfirm={() => deleteTarget && delMut.mutate(deleteTarget.id)}
                onCancel={() => setDeleteTarget(null)} />
        </div>
    );
}

// =========================================================================
// Zamanlama Profilleri
// =========================================================================

const emptySchedule = {
    profile_code: '', cluster_interval_seconds: 60, statements_interval_seconds: 300,
    db_objects_interval_seconds: 1800, hourly_rollup_interval_seconds: 3600,
    daily_rollup_hour_utc: 1, bootstrap_sql_text_batch: 100,
    max_databases_per_run: 5, statement_timeout_ms: 5000,
    lock_timeout_ms: 250, connect_timeout_seconds: 5, max_host_concurrency: 1, is_active: true,
};

function ScheduleTab() {
    const qc = useQueryClient();
    const toast = useToast();
    const [formMode, setFormMode] = useState<'closed' | 'add' | 'edit'>('closed');
    const [form, setForm] = useState(emptySchedule);
    const [editId, setEditId] = useState<number | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<{ id: number; code: string } | null>(null);
    // max_host_concurrency değiştiyse restart gerektiren uyarı banner'ı
    const [restartNotice, setRestartNotice] = useState(false);
    const [originalConcurrency, setOriginalConcurrency] = useState<number | null>(null);

    const { data, isLoading } = useQuery({ queryKey: ['schedule-profiles'], queryFn: () => apiGet<any[]>('/schedule-profiles') });

    const addMut = useMutation({
        mutationFn: (d: typeof form) => apiPost('/schedule-profiles', d),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedule-profiles'] }); setFormMode('closed'); toast.success('Profil kaydedildi.'); },
        onError: (e: Error) => toast.error('Profil kaydedilemedi: ' + e.message),
    });

    const editMut = useMutation({
        mutationFn: ({ id, data }: { id: number; data: any }) => apiPut(`/schedule-profiles/${id}`, data),
        onSuccess: (_res, vars) => {
            qc.invalidateQueries({ queryKey: ['schedule-profiles'] });
            setFormMode('closed');
            // max_host_concurrency değişti mi? Değiştiyse restart banner'ını göster.
            if (originalConcurrency !== null && vars.data.max_host_concurrency !== originalConcurrency) {
                setRestartNotice(true);
            } else {
                toast.success('Profil güncellendi. Diğer değişiklikler 5 saniye içinde devrede.');
            }
        },
        onError: (e: Error) => toast.error('Güncellenemedi: ' + e.message),
    });

    const delMut = useMutation({
        mutationFn: (id: number) => apiDelete(`/schedule-profiles/${id}`),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedule-profiles'] }); setDeleteTarget(null); toast.success('Profil silindi.'); },
        onError: (e: Error) => toast.error('Silinemedi: ' + e.message),
    });

    const openEdit = (r: any) => {
        setForm({ profile_code: r.profile_code, cluster_interval_seconds: r.cluster_interval_seconds, statements_interval_seconds: r.statements_interval_seconds, db_objects_interval_seconds: r.db_objects_interval_seconds, hourly_rollup_interval_seconds: r.hourly_rollup_interval_seconds, daily_rollup_hour_utc: r.daily_rollup_hour_utc, bootstrap_sql_text_batch: r.bootstrap_sql_text_batch, max_databases_per_run: r.max_databases_per_run, statement_timeout_ms: r.statement_timeout_ms, lock_timeout_ms: r.lock_timeout_ms, connect_timeout_seconds: r.connect_timeout_seconds, max_host_concurrency: r.max_host_concurrency, is_active: r.is_active });
        setEditId(r.schedule_profile_id);
        setOriginalConcurrency(r.max_host_concurrency);
        setFormMode('edit');
    };

    const columns = [
        { key: 'profile_code', header: 'Kod' },
        { key: 'cluster_interval_seconds', header: 'Cluster (s)', className: 'text-right' },
        { key: 'statements_interval_seconds', header: 'Stmts (s)', className: 'text-right' },
        { key: 'db_objects_interval_seconds', header: 'DbObj (s)', className: 'text-right' },
        { key: 'max_host_concurrency', header: 'Paralel', className: 'text-right' },
        { key: 'bound_instances', header: 'Bağlı', render: (r: any) => r.bound_instances, className: 'text-right' },
        { key: 'is_active', header: 'Durum', render: (r: any) => <Badge value={r.is_active ? 'ready' : 'paused'} /> },
        {
            key: 'actions', header: '', render: (r: any) => (
                <div className="flex gap-1">
                    <button onClick={() => openEdit(r)} className="px-2 py-1 text-xs bg-blue-50 text-blue-600 rounded hover:bg-blue-100">Düzenle</button>
                    {Number(r.bound_instances) === 0 ? (
                        <button onClick={() => setDeleteTarget({ id: r.schedule_profile_id, code: r.profile_code })} className="px-2 py-1 text-xs text-red-500 hover:text-red-700">Sil</button>
                    ) : (
                        <span className="px-2 py-1 text-xs text-[#94A3B8] cursor-not-allowed" title={`${r.bound_instances} instance bağlı`}>Sil</span>
                    )}
                </div>
            )
        },
    ];

    const nf = (label: string, key: keyof typeof form) => (
        <div>
            <label className="block text-xs text-[#64748B] mb-1">{label}</label>
            <input type="number" value={form[key] as number} onChange={(e) => setForm({ ...form, [key]: parseInt(e.target.value) || 0 })}
                className="w-full border border-[#E2E8F0] rounded px-3 py-2 text-sm" />
        </div>
    );

    return (
        <div>
            {restartNotice && (
                <div className="mb-4 bg-[#FEF3C7] border border-[#FCD34D] rounded-lg p-4 flex items-start gap-3">
                    <span className="text-2xl">⚠️</span>
                    <div className="flex-1 text-sm">
                        <div className="font-semibold text-[#92400E]">Collector Yeniden Başlatılmalı</div>
                        <div className="text-[#B45309] mt-1">
                            <b>Max Paralel Host</b> değeri değiştirildi. Bu ayar collector başlatılırken yüklenir,
                            değişikliğin etkili olması için:
                        </div>
                        <code className="inline-block mt-2 bg-white px-2 py-1 rounded text-xs text-[#92400E] border border-[#FCD34D]">
                            ./pgstat restart collector
                        </code>
                        <div className="text-xs text-[#78350F] mt-2">
                            Diğer tüm değişiklikler (interval, timeout) 5 saniye içinde otomatik devrede.
                        </div>
                    </div>
                    <button onClick={() => setRestartNotice(false)}
                        className="text-[#92400E] hover:text-[#78350F] text-xl leading-none">×</button>
                </div>
            )}
            <div className="flex justify-end mb-3">
                <button onClick={() => { setFormMode(formMode === 'closed' ? 'add' : 'closed'); setForm(emptySchedule); }}
                    className="px-3 py-1.5 text-sm bg-[#3B82F6] text-white rounded hover:bg-[#2563EB]">
                    {formMode !== 'closed' ? 'Kapat' : '+ Profil Ekle'}
                </button>
            </div>

            {formMode !== 'closed' && (
                <div className="bg-white rounded-lg shadow-sm p-5 mb-4">
                    <h3 className="text-sm font-semibold text-[#64748B] mb-3">{formMode === 'edit' ? 'Profil Düzenle' : 'Yeni Zamanlama Profili'}</h3>
                    {formMode === 'edit' && (
                        <div className="mb-3 text-xs bg-[#F0F9FF] border border-[#BAE6FD] text-[#0369A1] rounded-md px-3 py-2">
                            <strong>Bilgi:</strong> Interval ve timeout değişiklikleri <b>5 saniye içinde</b> devreye girer.
                            Sadece <b>Max Paralel Host</b> değişikliği için collector'ı yeniden başlatmak gerekir
                            (<code className="bg-white px-1 rounded">./pgstat restart collector</code>).
                        </div>
                    )}
                    <form onSubmit={(e) => { e.preventDefault(); formMode === 'edit' && editId ? editMut.mutate({ id: editId, data: form }) : addMut.mutate(form); }} className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div>
                            <label className="block text-xs text-[#64748B] mb-1">Kod *</label>
                            <input value={form.profile_code} onChange={(e) => setForm({ ...form, profile_code: e.target.value })}
                                disabled={formMode === 'edit'} placeholder="default"
                                className="w-full border border-[#E2E8F0] rounded px-3 py-2 text-sm disabled:bg-[#F1F5F9]" />
                        </div>
                        {nf('Cluster (s)', 'cluster_interval_seconds')}
                        {nf('Statements (s)', 'statements_interval_seconds')}
                        {nf('DbObjects (s)', 'db_objects_interval_seconds')}
                        {nf('Stmt Timeout (ms)', 'statement_timeout_ms')}
                        {nf('Lock Timeout (ms)', 'lock_timeout_ms')}
                        {nf('Connect Timeout (s)', 'connect_timeout_seconds')}
                        <div>
                            <label className="block text-xs text-[#64748B] mb-1 flex items-center gap-1">
                                Max Paralel Host
                                <span title="Bu ayar collector başlatılırken yüklenir. Değiştirdikten sonra ./pgstat restart collector gerekir."
                                      className="text-[#F59E0B] cursor-help">⚠</span>
                            </label>
                            <input type="number"
                                value={form.max_host_concurrency as number}
                                onChange={(e) => setForm({ ...form, max_host_concurrency: parseInt(e.target.value) || 0 })}
                                className="w-full border border-[#E2E8F0] rounded px-3 py-2 text-sm" />
                            {formMode === 'edit' && originalConcurrency !== null && form.max_host_concurrency !== originalConcurrency && (
                                <div className="text-[11px] text-[#B45309] mt-1">
                                    Restart gerekir (collector'ı yeniden başlatmadan etkili olmaz).
                                </div>
                            )}
                        </div>
                        {nf('SQL Text Batch', 'bootstrap_sql_text_batch')}
                        {nf('Max DB/Run', 'max_databases_per_run')}
                        {nf('Hourly Rollup (s)', 'hourly_rollup_interval_seconds')}
                        {nf('Daily Rollup Saat (UTC)', 'daily_rollup_hour_utc')}
                        <div className="flex items-center gap-2">
                            <label className="text-xs text-[#64748B]">Aktif</label>
                            <input type="checkbox" checked={form.is_active as boolean} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
                        </div>
                        <div className="col-span-full flex gap-2 justify-end">
                            <button type="button" onClick={() => setFormMode('closed')} className="px-3 py-1.5 text-sm border border-[#E2E8F0] rounded">İptal</button>
                            <button type="submit" className="px-3 py-1.5 text-sm bg-[#3B82F6] text-white rounded hover:bg-[#2563EB]">{formMode === 'edit' ? 'Güncelle' : 'Ekle'}</button>
                        </div>
                    </form>
                </div>
            )}

            <div className="bg-white rounded-lg shadow-sm p-4">
                {isLoading ? <div className="text-[#94A3B8] py-8 text-center">Yükleniyor...</div> : <DataTable columns={columns} data={data || []} />}
            </div>

            <ConfirmDialog open={!!deleteTarget} title="Profil Sil"
                message={`"${deleteTarget?.code}" profilini silmek istediğinize emin misiniz?`}
                onConfirm={() => deleteTarget && delMut.mutate(deleteTarget.id)}
                onCancel={() => setDeleteTarget(null)} />
        </div>
    );
}

// =========================================================================
// Alert Mesaj Şablonları
// =========================================================================

interface MessageTemplate {
    alert_code: string;
    title_template: string;
    message_template: string;
    description: string | null;
    updated_at: string;
}

const TEMPLATE_PLACEHOLDERS = [
    'instance', 'instance_pk', 'host', 'port',
    'severity', 'severity_upper', 'severity_emoji',
    'started_at', 'duration_minutes',
    'error_message', 'value', 'threshold',
    'lag_bytes', 'lag_human', 'pid', 'lock_mode', 'waiting_count',
    'job_type', 'failed_count', 'total_count',
];

function MessageTemplatesTab() {
    const { data = [], isLoading } = useQuery<MessageTemplate[]>({
        queryKey: ['message-templates'],
        queryFn: () => apiGet('/alert-rules/message-templates'),
    });
    const [editing, setEditing] = useState<MessageTemplate | null>(null);

    if (isLoading) return <div className="text-sm text-[#64748B]">Yükleniyor...</div>;

    return (
        <div>
            <div className="bg-[#EFF6FF] border border-[#BFDBFE] rounded-md px-4 py-3 mb-4 text-sm text-[#1E40AF]">
                💡 Sistem alert kodları için varsayılan başlık ve mesaj şablonları. Bir kodu düzenleyince
                tüm o tip alert'ler yeni şablonu kullanır. Custom kurallar kendi şablonlarını AlertRules
                sayfasından düzenler.
            </div>

            <div className="bg-white border border-[#E2E8F0] rounded-lg overflow-hidden">
                <table className="w-full">
                    <thead className="bg-[#F8FAFC] border-b border-[#E2E8F0]">
                        <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium text-[#64748B]">Alert Kodu</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-[#64748B]">Başlık Şablonu</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-[#64748B]">Açıklama</th>
                            <th className="px-4 py-2 text-right text-xs font-medium text-[#64748B]"></th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-[#F1F5F9]">
                        {data.map(t => (
                            <tr key={t.alert_code} className="hover:bg-[#F8FAFC]">
                                <td className="px-4 py-2 text-sm font-mono text-[#1E293B]">{t.alert_code}</td>
                                <td className="px-4 py-2 text-xs font-mono text-[#475569] max-w-md truncate">{t.title_template}</td>
                                <td className="px-4 py-2 text-xs text-[#64748B]">{t.description || '—'}</td>
                                <td className="px-4 py-2 text-right">
                                    <button onClick={() => setEditing(t)}
                                        className="text-xs text-[#3B82F6] hover:underline">Düzenle</button>
                                </td>
                            </tr>
                        ))}
                        {data.length === 0 && (
                            <tr><td colSpan={4} className="px-4 py-6 text-center text-sm text-[#64748B]">
                                Henüz şablon yok — V030 migration'ı uygulayın.
                            </td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            {editing && <TemplateEditModal template={editing} onClose={() => setEditing(null)} />}
        </div>
    );
}

function TemplateEditModal({ template, onClose }: { template: MessageTemplate; onClose: () => void }) {
    const qc = useQueryClient();
    const toast = useToast();
    const [title, setTitle] = useState(template.title_template);
    const [message, setMessage] = useState(template.message_template);
    const [activeField, setActiveField] = useState<'title' | 'message'>('message');
    const [preview, setPreview] = useState<{ title: string; message: string } | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);

    const saveMut = useMutation({
        mutationFn: () => apiPut(`/alert-rules/message-templates/${template.alert_code}`, {
            title_template: title,
            message_template: message,
        }),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['message-templates'] });
            toast.success('Şablon güncellendi');
            onClose();
        },
        onError: (e: any) => toast.error(e.message || 'Hata oluştu'),
    });

    const insertPlaceholder = (key: string) => {
        const token = `{{${key}}}`;
        if (activeField === 'title') setTitle(t => t + token);
        else setMessage(m => m + token);
    };

    const runPreview = async () => {
        setPreviewLoading(true);
        try {
            const r = await apiPost<{ title: string; message: string }>('/alert-rules/preview', {
                title_template: title,
                message_template: message,
            });
            setPreview({ title: r.title, message: r.message });
        } catch (e: any) {
            setPreview({ title: 'Hata: ' + e.message, message: '' });
        } finally {
            setPreviewLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
                <div className="px-6 py-4 border-b border-[#E2E8F0] flex items-center justify-between">
                    <h2 className="font-semibold text-[#1E293B]">
                        Şablon: <code className="text-sm text-[#3B82F6]">{template.alert_code}</code>
                    </h2>
                    <button onClick={onClose} className="text-[#94A3B8] hover:text-[#475569] text-xl">×</button>
                </div>

                <div className="px-6 py-4 space-y-3">
                    {template.description && (
                        <div className="text-xs text-[#64748B] italic">{template.description}</div>
                    )}

                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Başlık Şablonu</label>
                        <input type="text" value={title} onChange={e => setTitle(e.target.value)}
                            onFocus={() => setActiveField('title')}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-[#3B82F6]" />
                    </div>

                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Mesaj Şablonu</label>
                        <textarea value={message} onChange={e => setMessage(e.target.value)}
                            onFocus={() => setActiveField('message')} rows={9}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-[#3B82F6] resize-y" />
                    </div>

                    <div>
                        <div className="text-xs font-medium text-[#475569] mb-1">
                            Placeholder'lar (tıklayarak {activeField === 'title' ? 'başlığa' : 'mesaja'} ekle)
                        </div>
                        <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto border border-[#E2E8F0] rounded-md p-2 bg-[#F8FAFC]">
                            {TEMPLATE_PLACEHOLDERS.map(k => (
                                <button key={k} type="button" onClick={() => insertPlaceholder(k)}
                                    className="px-2 py-0.5 bg-white border border-[#CBD5E1] rounded text-[11px] font-mono text-[#3B82F6] hover:bg-[#EFF6FF] hover:border-[#3B82F6]">
                                    {`{{${k}}}`}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex gap-2">
                        <button type="button" onClick={runPreview} disabled={previewLoading}
                            className="px-3 py-1.5 bg-[#3B82F6] text-white text-xs rounded-md hover:bg-[#2563EB] disabled:opacity-50">
                            {previewLoading ? 'Oluşturuluyor...' : '👁 Önizle'}
                        </button>
                    </div>

                    {preview && (
                        <div className="border border-[#22C55E] rounded-md overflow-hidden">
                            <div className="bg-[#DCFCE7] px-3 py-1 text-xs font-medium text-[#15803D]">Önizleme (örnek değerlerle)</div>
                            <div className="bg-white p-3 space-y-2">
                                <div>
                                    <div className="text-[10px] uppercase text-[#94A3B8] mb-0.5">Başlık</div>
                                    <div className="text-sm font-medium text-[#1E293B]">{preview.title}</div>
                                </div>
                                <div>
                                    <div className="text-[10px] uppercase text-[#94A3B8] mb-0.5">Mesaj</div>
                                    <pre className="text-xs text-[#1E293B] whitespace-pre-wrap font-mono bg-[#F8FAFC] p-2 rounded border border-[#E2E8F0]">{preview.message}</pre>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

                <div className="px-6 py-4 border-t border-[#E2E8F0] flex justify-end gap-2">
                    <button onClick={onClose} className="px-4 py-2 text-sm text-[#475569] hover:text-[#1E293B]">İptal</button>
                    <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
                        className="px-5 py-2 bg-[#22C55E] text-white text-sm rounded-md hover:bg-[#16A34A] disabled:opacity-50">
                        {saveMut.isPending ? 'Kaydediliyor...' : 'Kaydet'}
                    </button>
                </div>
            </div>
        </div>
    );
}
