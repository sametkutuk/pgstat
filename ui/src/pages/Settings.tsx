import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, apiDelete } from '../api/client';
import DataTable from '../components/common/DataTable';
import Badge from '../components/common/Badge';
import ConfirmDialog from '../components/common/ConfirmDialog';
import { useToast } from '../components/common/Toast';
import { useState } from 'react';

export default function Settings() {
    const [tab, setTab] = useState<'retention' | 'schedule'>('retention');
    const tabs = [
        { key: 'retention' as const, label: 'Retention Politikaları' },
        { key: 'schedule' as const, label: 'Zamanlama Profilleri' },
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
        </div>
    );
}

// =========================================================================
// Retention Politikaları
// =========================================================================

const emptyRetention = { policy_code: '', raw_retention_months: 6, hourly_retention_months: 3, daily_retention_months: 24, purge_enabled: true, is_active: true };

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
        setForm({ policy_code: r.policy_code, raw_retention_months: r.raw_retention_months, hourly_retention_months: r.hourly_retention_months, daily_retention_months: r.daily_retention_months, purge_enabled: r.purge_enabled, is_active: r.is_active });
        setEditId(r.retention_policy_id);
        setFormMode('edit');
    };

    const columns = [
        { key: 'policy_code', header: 'Kod' },
        { key: 'raw_retention_months', header: 'Raw (ay)', className: 'text-right' },
        { key: 'hourly_retention_months', header: 'Hourly (ay)', className: 'text-right' },
        { key: 'daily_retention_months', header: 'Daily (ay)', className: 'text-right' },
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
                    <form onSubmit={(e) => { e.preventDefault(); formMode === 'edit' && editId ? editMut.mutate({ id: editId, data: form }) : addMut.mutate(form); }} className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div>
                            <label className="block text-xs text-[#64748B] mb-1">Kod *</label>
                            <input value={form.policy_code} onChange={(e) => setForm({ ...form, policy_code: e.target.value })}
                                disabled={formMode === 'edit'} placeholder="standard"
                                className="w-full border border-[#E2E8F0] rounded px-3 py-2 text-sm disabled:bg-[#F1F5F9]" />
                        </div>
                        {numField('Raw (ay)', 'raw_retention_months')}
                        {numField('Hourly (ay)', 'hourly_retention_months')}
                        {numField('Daily (ay)', 'daily_retention_months')}
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

    const { data, isLoading } = useQuery({ queryKey: ['schedule-profiles'], queryFn: () => apiGet<any[]>('/schedule-profiles') });

    const addMut = useMutation({
        mutationFn: (d: typeof form) => apiPost('/schedule-profiles', d),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedule-profiles'] }); setFormMode('closed'); toast.success('Profil kaydedildi.'); },
        onError: (e: Error) => toast.error('Profil kaydedilemedi: ' + e.message),
    });

    const editMut = useMutation({
        mutationFn: ({ id, data }: { id: number; data: any }) => apiPut(`/schedule-profiles/${id}`, data),
        onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedule-profiles'] }); setFormMode('closed'); toast.success('Profil güncellendi.'); },
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
            <div className="flex justify-end mb-3">
                <button onClick={() => { setFormMode(formMode === 'closed' ? 'add' : 'closed'); setForm(emptySchedule); }}
                    className="px-3 py-1.5 text-sm bg-[#3B82F6] text-white rounded hover:bg-[#2563EB]">
                    {formMode !== 'closed' ? 'Kapat' : '+ Profil Ekle'}
                </button>
            </div>

            {formMode !== 'closed' && (
                <div className="bg-white rounded-lg shadow-sm p-5 mb-4">
                    <h3 className="text-sm font-semibold text-[#64748B] mb-3">{formMode === 'edit' ? 'Profil Düzenle' : 'Yeni Zamanlama Profili'}</h3>
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
                        {nf('Max Paralel Host', 'max_host_concurrency')}
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
