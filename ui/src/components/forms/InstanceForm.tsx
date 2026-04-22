import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../api/client';

export interface InstanceFormData {
    instance_id: string;
    display_name: string;
    environment: string;
    service_group: string;
    host: string;
    port: number;
    admin_dbname: string;
    collector_username: string;
    password: string;
    secret_ref: string;
    ssl_mode: string;
    ssl_root_cert_path: string;
    schedule_profile_id: number | null;
    retention_policy_id: number | null;
    collector_group: string;
    notes: string;
}

const emptyForm: InstanceFormData = {
    instance_id: '', display_name: '', environment: '', service_group: '',
    host: '', port: 5432, admin_dbname: 'postgres', collector_username: 'pgstats_collector',
    password: '', secret_ref: '',
    ssl_mode: 'prefer', ssl_root_cert_path: '',
    schedule_profile_id: null, retention_policy_id: null,
    collector_group: '', notes: '',
};

interface Props {
    initial?: Partial<InstanceFormData>;
    onSubmit: (data: InstanceFormData) => void;
    onCancel: () => void;
    isEdit?: boolean;
}

export default function InstanceForm({ initial, onSubmit, onCancel, isEdit }: Props) {
    const [form, setForm] = useState<InstanceFormData>({ ...emptyForm, ...initial });
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [authMode, setAuthMode] = useState<'password' | 'secret_ref'>('password');

    useEffect(() => {
        if (initial) {
            setForm({ ...emptyForm, ...initial });
            // Düzenleme modunda secret_ref varsa secret_ref moduna geç
            if (isEdit && initial.secret_ref && initial.secret_ref.startsWith('env:')) {
                setAuthMode('secret_ref');
            }
        }
    }, [initial, isEdit]);

    const profiles = useQuery({ queryKey: ['schedule-profiles'], queryFn: () => apiGet<any[]>('/schedule-profiles') });
    const policies = useQuery({ queryKey: ['retention-policies'], queryFn: () => apiGet<any[]>('/retention-policies') });

    const set = (key: keyof InstanceFormData, value: any) =>
        setForm((f) => ({ ...f, [key]: value }));

    const validate = (): boolean => {
        const e: Record<string, string> = {};
        if (!form.instance_id.trim()) e.instance_id = 'Zorunlu';
        if (!form.display_name.trim()) e.display_name = 'Zorunlu';
        if (!form.host.trim()) e.host = 'Zorunlu';
        if (form.port < 1 || form.port > 65535) e.port = '1-65535 arası olmalı';
        if (!form.admin_dbname.trim()) e.admin_dbname = 'Zorunlu';

        if (authMode === 'password') {
            if (!isEdit && !form.password.trim()) e.password = 'Şifre zorunlu';
        } else {
            if (!form.secret_ref.trim()) {
                e.secret_ref = 'Zorunlu';
            } else if (!/^(file:|env:|vault:)/.test(form.secret_ref)) {
                e.secret_ref = 'file:, env: veya vault: ile başlamalı';
            }
        }

        if ((form.ssl_mode === 'verify-ca' || form.ssl_mode === 'verify-full') && !form.ssl_root_cert_path.trim()) {
            e.ssl_root_cert_path = 'verify-ca/verify-full için zorunlu';
        }
        if (!form.schedule_profile_id) e.schedule_profile_id = 'Seçiniz';
        if (!form.retention_policy_id) e.retention_policy_id = 'Seçiniz';
        setErrors(e);
        return Object.keys(e).length === 0;
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (validate()) {
            // password modunda secret_ref'i temizle, secret_ref modunda password'u temizle
            const data = { ...form };
            if (authMode === 'password') {
                data.secret_ref = '';
            } else {
                data.password = '';
            }
            onSubmit(data);
        }
    };

    const needsCert = form.ssl_mode === 'verify-ca' || form.ssl_mode === 'verify-full';

    return (
        <form onSubmit={handleSubmit} className="space-y-4">
            {!isEdit && <SetupGuide username={form.collector_username || 'pgstat_collector'} />}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Instance ID *" value={form.instance_id} disabled={isEdit}
                    onChange={(v) => set('instance_id', v)} placeholder="prod-pg-01" error={errors.instance_id} />
                <Field label="Görünen Ad *" value={form.display_name}
                    onChange={(v) => set('display_name', v)} placeholder="Production PG 01" error={errors.display_name} />
                <Field label="Host *" value={form.host}
                    onChange={(v) => set('host', v)} placeholder="192.168.1.10" error={errors.host} />
                <Field label="Port *" value={String(form.port)} type="number"
                    onChange={(v) => set('port', parseInt(v) || 5432)} error={errors.port} />
                <Field label="Admin Database *" value={form.admin_dbname}
                    onChange={(v) => set('admin_dbname', v)} placeholder="postgres" error={errors.admin_dbname} />
                <Field label="Kullanıcı Adı *" value={form.collector_username}
                    onChange={(v) => set('collector_username', v)} placeholder="pgstats_collector"
                    hint="Kaynak PG'ye bağlanacak kullanıcı" />

                {/* Kimlik doğrulama bölümü */}
                <div className="md:col-span-2 border border-[#E2E8F0] rounded-lg p-4">
                    <div className="flex items-center gap-4 mb-3">
                        <span className="text-xs font-semibold text-[#64748B]">Kimlik Doğrulama</span>
                        <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                            <input type="radio" name="authMode" checked={authMode === 'password'}
                                onChange={() => setAuthMode('password')} />
                            Şifre
                        </label>
                        <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                            <input type="radio" name="authMode" checked={authMode === 'secret_ref'}
                                onChange={() => setAuthMode('secret_ref')} />
                            Secret Ref (gelişmiş)
                        </label>
                    </div>

                    {authMode === 'password' ? (
                        <div>
                            <Field label={isEdit ? 'Yeni Şifre (değiştirmek için doldurun)' : 'Şifre *'}
                                value={form.password} type="password"
                                onChange={(v) => set('password', v)}
                                placeholder={isEdit ? '●●●●●● (değiştirmek için yeni şifre girin)' : 'PostgreSQL şifresi'}
                                error={errors.password}
                                hint="Şifre AES-256 ile encrypt edilip sunucuda saklanır" />
                        </div>
                    ) : (
                        <Field label="Secret Ref *" value={form.secret_ref}
                            onChange={(v) => set('secret_ref', v)}
                            placeholder="env:PGSTAT_PASSWORD_PROD01"
                            error={errors.secret_ref}
                            hint="file:/path, env:VAR_NAME veya vault:secret/path" />
                    )}
                </div>

                <SelectField label="SSL Mode *" value={form.ssl_mode}
                    onChange={(v) => set('ssl_mode', v)}
                    options={['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full']} />
                {needsCert && (
                    <Field label="SSL Root Cert Path *" value={form.ssl_root_cert_path}
                        onChange={(v) => set('ssl_root_cert_path', v)} placeholder="/etc/ssl/certs/ca.pem"
                        error={errors.ssl_root_cert_path} />
                )}
                <Field label="Ortam" value={form.environment}
                    onChange={(v) => set('environment', v)} placeholder="production" />
                <Field label="Servis Grubu" value={form.service_group}
                    onChange={(v) => set('service_group', v)} placeholder="payment-service" />
                <Field label="Collector Group" value={form.collector_group}
                    onChange={(v) => set('collector_group', v)} placeholder="dc-istanbul" />
                <SelectField label="Zamanlama Profili *"
                    value={form.schedule_profile_id ? String(form.schedule_profile_id) : ''}
                    onChange={(v) => set('schedule_profile_id', parseInt(v) || null)}
                    options={(profiles.data || []).map((p: any) => ({ value: String(p.schedule_profile_id), label: p.profile_code }))}
                    error={errors.schedule_profile_id} />
                <SelectField label="Retention Politikası *"
                    value={form.retention_policy_id ? String(form.retention_policy_id) : ''}
                    onChange={(v) => set('retention_policy_id', parseInt(v) || null)}
                    options={(policies.data || []).map((p: any) => ({ value: String(p.retention_policy_id), label: p.policy_code }))}
                    error={errors.retention_policy_id} />
            </div>
            <div>
                <label className="block text-xs text-[#64748B] mb-1">Notlar</label>
                <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)}
                    className="w-full border border-[#E2E8F0] rounded px-3 py-2 text-sm" rows={2} />
            </div>
            <div className="flex gap-2 justify-end pt-2">
                <button type="button" onClick={onCancel}
                    className="px-4 py-2 text-sm border border-[#E2E8F0] rounded hover:bg-[#F8FAFC]">İptal</button>
                <button type="submit"
                    className="px-4 py-2 text-sm bg-[#3B82F6] text-white rounded hover:bg-[#2563EB]">
                    {isEdit ? 'Güncelle' : 'Ekle'}
                </button>
            </div>
        </form>
    );
}

// =============================================================================
// Kaynak sunucu kurulum rehberi — sadece yeni instance eklerken gösterilir
// =============================================================================

function CopyButton({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    const copy = useCallback(() => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    }, [text]);
    return (
        <button type="button" onClick={copy}
            className="text-xs px-2 py-0.5 rounded border border-[#CBD5E1] text-[#64748B] hover:bg-[#F1F5F9] transition-colors">
            {copied ? '✓ Kopyalandı' : 'Kopyala'}
        </button>
    );
}

function SqlBlock({ sql }: { sql: string }) {
    return (
        <div className="relative mt-1.5 bg-[#0F172A] rounded-md overflow-hidden">
            <div className="absolute right-2 top-2">
                <CopyButton text={sql} />
            </div>
            <pre className="text-xs text-[#94A3B8] p-3 pr-20 overflow-x-auto leading-relaxed font-mono whitespace-pre">{sql}</pre>
        </div>
    );
}

function SetupGuide({ username }: { username: string }) {
    const [open, setOpen] = useState(false);

    const sql1 = `-- 1. Collector kullanıcısını oluştur ve yetki ver
CREATE USER ${username} WITH PASSWORD 'güçlü_şifre_girin';
GRANT pg_monitor TO ${username};
-- PG9 / PG10 için pg_monitor yoksa:
-- GRANT pg_read_all_stats TO ${username};
-- GRANT pg_read_all_settings TO ${username};`;

    const sql2 = `-- 2. pg_stat_statements kurulum kontrolü
SHOW shared_preload_libraries;

-- Eğer 'pg_stat_statements' görünmüyorsa postgresql.conf'a ekle:
--   shared_preload_libraries = 'pg_stat_statements'
--   pg_stat_statements.track = all
-- Ardından PostgreSQL'i yeniden başlat, sonra:
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Doğrulama:
SELECT count(*) FROM pg_stat_statements;`;

    const sql3 = `-- 3. İzlenecek her veritabanı için CONNECT yetkisi ver
GRANT CONNECT ON DATABASE postgres TO ${username};
-- GRANT CONNECT ON DATABASE myapp TO ${username};
-- GRANT CONNECT ON DATABASE myapp2 TO ${username};`;

    return (
        <div className="border border-amber-200 bg-amber-50 rounded-lg overflow-hidden">
            <button type="button"
                onClick={() => setOpen(v => !v)}
                className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-amber-100/60 transition-colors">
                <div className="flex items-center gap-2">
                    <span className="text-amber-600 text-base">⚠</span>
                    <span className="text-sm font-semibold text-amber-800">Kaynak Sunucu Kurulum Rehberi</span>
                    <span className="text-xs text-amber-600">— Kayıt öncesi kaynak PostgreSQL'de çalıştırılması gereken komutlar</span>
                </div>
                <span className="text-amber-600 text-xs font-medium">{open ? '▲ Gizle' : '▼ Göster'}</span>
            </button>

            {open && (
                <div className="px-4 pb-4 space-y-4 border-t border-amber-200">
                    {/* Adım 1 */}
                    <div className="pt-3">
                        <div className="flex items-center gap-2 mb-1">
                            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-amber-500 text-white text-xs flex items-center justify-center font-bold">1</span>
                            <span className="text-xs font-semibold text-[#1E293B]">Collector kullanıcısı oluştur</span>
                        </div>
                        <p className="text-xs text-[#64748B] mb-1 ml-7">Kaynak PostgreSQL'e superuser ile bağlanıp çalıştır.</p>
                        <SqlBlock sql={sql1} />
                    </div>

                    {/* Adım 2 */}
                    <div>
                        <div className="flex items-center gap-2 mb-1">
                            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-amber-500 text-white text-xs flex items-center justify-center font-bold">2</span>
                            <span className="text-xs font-semibold text-[#1E293B]">pg_stat_statements extension'ını etkinleştir</span>
                        </div>
                        <p className="text-xs text-[#64748B] mb-1 ml-7">
                            Zaten yüklüyse bu adımı atla. Yükleme için PostgreSQL restart gerekir.
                        </p>
                        <SqlBlock sql={sql2} />
                    </div>

                    {/* Adım 3 */}
                    <div>
                        <div className="flex items-center gap-2 mb-1">
                            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-amber-500 text-white text-xs flex items-center justify-center font-bold">3</span>
                            <span className="text-xs font-semibold text-[#1E293B]">Veritabanlarına erişim ver</span>
                        </div>
                        <p className="text-xs text-[#64748B] mb-1 ml-7">İzlenecek her veritabanı için CONNECT yetkisi ver.</p>
                        <SqlBlock sql={sql3} />
                    </div>

                    {/* Not */}
                    <div className="bg-white border border-amber-200 rounded p-3 text-xs text-[#64748B] space-y-1">
                        <div className="font-semibold text-[#1E293B] mb-1">Bağlantı testi</div>
                        <code className="block bg-[#F8FAFC] px-2 py-1 rounded font-mono">
                            psql -h &lt;host&gt; -U {username} -d postgres -c "SELECT count(*) FROM pg_stat_statements;"
                        </code>
                        <div>Sonuç bir sayı ise kayıt yapmaya hazırsın.</div>
                    </div>
                </div>
            )}
        </div>
    );
}

function Field({ label, value, onChange, placeholder, type = 'text', disabled, error, hint }: {
    label: string; value: string; onChange: (v: string) => void;
    placeholder?: string; type?: string; disabled?: boolean; error?: string; hint?: string;
}) {
    return (
        <div>
            <label className="block text-xs text-[#64748B] mb-1">{label}</label>
            <input type={type} value={value} onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder} disabled={disabled}
                className={`w-full border rounded px-3 py-2 text-sm disabled:bg-[#F1F5F9] ${error ? 'border-red-400' : 'border-[#E2E8F0]'}`} />
            {hint && !error && <div className="text-xs text-[#94A3B8] mt-0.5">{hint}</div>}
            {error && <div className="text-xs text-red-500 mt-0.5">{error}</div>}
        </div>
    );
}

function SelectField({ label, value, onChange, options, error }: {
    label: string; value: string; onChange: (v: string) => void;
    options: string[] | { value: string; label: string }[]; error?: string;
}) {
    const opts = options.map((o) => typeof o === 'string' ? { value: o, label: o } : o);
    return (
        <div>
            <label className="block text-xs text-[#64748B] mb-1">{label}</label>
            <select value={value} onChange={(e) => onChange(e.target.value)}
                className={`w-full border rounded px-3 py-2 text-sm bg-white ${error ? 'border-red-400' : 'border-[#E2E8F0]'}`}>
                <option value="">Seçiniz...</option>
                {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {error && <div className="text-xs text-red-500 mt-0.5">{error}</div>}
        </div>
    );
}
