import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiGet, apiPost, apiPut, apiPatch } from '../api/client';
import DataTable from '../components/common/DataTable';
import Badge from '../components/common/Badge';
import TimeAgo from '../components/common/TimeAgo';
import InstanceForm from '../components/forms/InstanceForm';
import type { InstanceFormData } from '../components/forms/InstanceForm';
import { useToast } from '../components/common/Toast';
import { useState } from 'react';

interface Instance {
    instance_pk: number; instance_id: string; display_name: string;
    environment: string | null; service_group: string | null;
    host: string; port: number; is_active: boolean; bootstrap_state: string;
    pg_major: number | null; is_primary: boolean | null;
    last_cluster_collect_at: string | null; consecutive_failures: number;
    admin_dbname: string; secret_ref: string; ssl_mode: string;
    ssl_root_cert_path: string | null; collector_group: string | null;
    collector_username: string;
    schedule_profile_id: number; retention_policy_id: number; notes: string | null;
}

export default function Instances() {
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const toast = useToast();
    const [formMode, setFormMode] = useState<'closed' | 'add' | 'edit'>('closed');
    const [editInstance, setEditInstance] = useState<Instance | null>(null);

    const { data, isLoading } = useQuery({
        queryKey: ['instances'],
        queryFn: () => apiGet<Instance[]>('/instances'),
    });

    const addMutation = useMutation({
        mutationFn: (d: InstanceFormData) => apiPost('/instances', d),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['instances'] }); setFormMode('closed'); toast.success('Instance eklendi.'); },
        onError: (e: Error) => toast.error('Eklenemedi: ' + e.message),
    });

    const editMutation = useMutation({
        mutationFn: ({ id, data }: { id: number; data: InstanceFormData }) => apiPut(`/instances/${id}`, data),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['instances'] }); setFormMode('closed'); toast.success('Instance güncellendi.'); },
        onError: (e: Error) => toast.error('Güncellenemedi: ' + e.message),
    });

    const toggleMutation = useMutation({
        mutationFn: (id: number) => apiPatch(`/instances/${id}/toggle`),
        onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['instances'] }); toast.success('Durum değiştirildi.'); },
    });

    const openEdit = (inst: Instance) => {
        setEditInstance(inst);
        setFormMode('edit');
    };

    const columns = [
        {
            key: 'display_name', header: 'Instance', render: (r: Instance) => (
                <div><div className="font-medium">{r.display_name}</div><div className="text-xs text-[#94A3B8]">{r.host}:{r.port}</div></div>
            )
        },
        { key: 'bootstrap_state', header: 'Durum', render: (r: Instance) => <Badge value={r.bootstrap_state} /> },
        { key: 'pg_major', header: 'PG', render: (r: Instance) => r.pg_major ? `PG${r.pg_major}` : '—' },
        { key: 'is_primary', header: 'Rol', render: (r: Instance) => r.is_primary === null ? '—' : r.is_primary ? 'Primary' : 'Replica' },
        { key: 'environment', header: 'Ortam', render: (r: Instance) => r.environment || '—' },
        { key: 'service_group', header: 'Servis Grubu', render: (r: Instance) => r.service_group || '—' },
        { key: 'last_cluster_collect_at', header: 'Son Cluster', render: (r: Instance) => <TimeAgo date={r.last_cluster_collect_at} /> },
        { key: 'consecutive_failures', header: 'Hatalar', render: (r: Instance) => r.consecutive_failures > 0 ? <span className="text-red-600 font-medium">{r.consecutive_failures}</span> : <span className="text-green-600">0</span> },
        {
            key: 'actions', header: '', render: (r: Instance) => (
                <div className="flex gap-1">
                    <button onClick={(e) => { e.stopPropagation(); openEdit(r); }}
                        className="px-2 py-1 text-xs bg-blue-50 text-blue-600 rounded hover:bg-blue-100">Düzenle</button>
                    <button onClick={(e) => { e.stopPropagation(); toggleMutation.mutate(r.instance_pk); }}
                        className={`px-2 py-1 text-xs rounded ${r.is_active ? 'bg-red-50 text-red-600 hover:bg-red-100' : 'bg-green-50 text-green-600 hover:bg-green-100'}`}>
                        {r.is_active ? 'Durdur' : 'Başlat'}
                    </button>
                </div>
            )
        },
    ];

    return (
        <div>
            <div className="flex items-center justify-between mb-5">
                <h1 className="text-xl font-bold">Instances</h1>
                <button onClick={() => { setFormMode(formMode === 'closed' ? 'add' : 'closed'); setEditInstance(null); }}
                    className="px-4 py-2 text-sm bg-[#3B82F6] text-white rounded hover:bg-[#2563EB]">
                    {formMode !== 'closed' ? 'Kapat' : '+ Instance Ekle'}
                </button>
            </div>

            {formMode !== 'closed' && (
                <div className="bg-white rounded-lg shadow-sm p-5 mb-5">
                    <h2 className="text-sm font-semibold text-[#64748B] mb-4">
                        {formMode === 'edit' ? 'Instance Düzenle' : 'Yeni Instance'}
                    </h2>
                    <InstanceForm
                        initial={formMode === 'edit' && editInstance ? {
                            instance_id: editInstance.instance_id,
                            display_name: editInstance.display_name,
                            environment: editInstance.environment || '',
                            service_group: editInstance.service_group || '',
                            host: editInstance.host,
                            port: editInstance.port,
                            admin_dbname: editInstance.admin_dbname,
                            collector_username: editInstance.collector_username || 'pgstats_collector',
                            secret_ref: editInstance.secret_ref,
                            ssl_mode: editInstance.ssl_mode,
                            ssl_root_cert_path: editInstance.ssl_root_cert_path || '',
                            schedule_profile_id: editInstance.schedule_profile_id,
                            retention_policy_id: editInstance.retention_policy_id,
                            collector_group: editInstance.collector_group || '',
                            notes: editInstance.notes || '',
                        } : undefined}
                        isEdit={formMode === 'edit'}
                        onSubmit={(d) => {
                            if (formMode === 'edit' && editInstance) {
                                editMutation.mutate({ id: editInstance.instance_pk, data: d });
                            } else {
                                addMutation.mutate(d);
                            }
                        }}
                        onCancel={() => setFormMode('closed')}
                    />
                </div>
            )}

            <div className="bg-white rounded-lg shadow-sm p-4">
                {isLoading ? <div className="text-[#94A3B8] py-8 text-center">Yükleniyor...</div> : (
                    <DataTable columns={columns} data={data || []} onRowClick={(r) => navigate(`/instances/${r.instance_pk}`)} />
                )}
            </div>
        </div>
    );
}
