import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, apiDelete } from '../api/client';
import { useToast } from '../components/common/Toast';
import InfoTip from '../components/common/InfoTip';
import { Modal, ModalFooter } from '../components/common/Modal';

// =========================================================================
// Bildirim Kanalları
// Daha once AdaptiveAlerting icindeydi; Ayarlar sayfasina tasindi.
// =========================================================================

interface NotificationChannel {
    channel_id: number;
    channel_name: string;
    channel_type: 'email' | 'slack' | 'pagerduty' | 'teams' | 'webhook' | 'telegram';
    config: any;
    min_severity: string | null;
    is_enabled: boolean;
    // Bu kanalin kabul ettigi alarm tipleri; BOS DIZI = kisitlama yok,
    // kanal tum tipleri alir (V099).
    alert_codes?: string[];
}

const TYPE_ICONS: Record<string, string> = {
    email: '📧', slack: '💬', pagerduty: '🚨', teams: '👥', webhook: '🔗', telegram: '✈️',
};

// Kanal bazli alarm tipi filtresi (V099) icin secim listesi kaydi
interface AlertCodeInfo {
    alert_code: string;
    description: string | null;
    alert_source: string | null;
    last_severity: string | null;
    count_30d: number | string;
}

// Alarm kodlari kaynagina gore gruplanir: sistem alarmlari (collector'in kendi
// sagligi), adaptive alarmlar (canli gozlem) ve kullanici kurallari birbirinden
// farkli seyler; karisik tek liste okunmuyor.
const CODE_GROUPS = [
    { key: 'user_rule', label: 'Kural alarmları' },
    { key: 'adaptive', label: 'Canlı gözlem alarmları' },
    { key: 'system', label: 'Sistem sağlığı alarmları' },
    { key: 'other', label: 'Diğer' },
] as const;

/** Hic uretilmemis kodlarin kaynagi bilinmez; onlar "diger" grubuna duser. */
function codeGroupOf(c: AlertCodeInfo): string {
    const src = c.alert_source;
    if (src === 'user_rule' || src === 'adaptive' || src === 'system') return src;
    return 'other';
}

const SEVERITY_STYLES: Record<string, string> = {
    info: 'bg-[#EFF6FF] text-[#2563EB]',
    warning: 'bg-[#FEFCE8] text-[#A16207]',
    error: 'bg-[#FFF7ED] text-[#C2410C]',
    critical: 'bg-[#FEF2F2] text-[#DC2626]',
    emergency: 'bg-[#FDF2F8] text-[#BE185D]',
};

// Settings sayfasi bu component'i sekme icinde render eder.
export default function NotificationChannelsTab() {
    return <ChannelsPanel />;
}

function ChannelsPanel() {
    const toast = useToast();
    const qc = useQueryClient();
    const [showForm, setShowForm] = useState(false);
    const [editingChannel, setEditingChannel] = useState<NotificationChannel | null>(null);

    const { data: channels = [] } = useQuery<NotificationChannel[]>({
        queryKey: ['channels'],
        queryFn: () => apiGet('/adaptive-alerting/notification-channels'),
    });

    const deleteMut = useMutation({
        mutationFn: (id: number) => apiDelete(`/adaptive-alerting/notification-channels/${id}`),
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['channels'] });
            toast.success('Kanal silindi');
        },
    });

    const testMut = useMutation({
        mutationFn: (id: number) => apiPost(`/adaptive-alerting/notification-channels/${id}/test`, {}),
        onSuccess: () => toast.success('Test gönderildi'),
        onError: (e: any) => toast.error(e?.message || 'Test başarısız'),
    });

    return (
        <div className="space-y-4">
            <div className="flex justify-between items-center">
                <div className="flex items-center gap-2">
                    <p className="text-sm text-[#64748B]">
                        Alert oluşunca bildirim gitmesi için kanal tanımla.
                    </p>
                    <InfoTip text="Bildirim kanalları alert oluştuğunda otomatik mesaj gönderir. Telegram: BotFather'dan bot oluşturun, gruba ekleyin, chat_id'yi /getUpdates ile bulun. Teams: Incoming Webhook connector ekleyin. Email: .env'de SMTP ayarlarını yapın (PGSTAT_SMTP_HOST vb.). Min severity ile sadece kritik alert'lerde bildirim alabilirsiniz." />
                </div>
                <button onClick={() => setShowForm(true)}
                    className="px-4 py-2 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB]">
                    + Kanal Ekle
                </button>
            </div>

            {channels.length === 0 ? (
                <div className="text-center py-12 text-[#64748B] text-sm bg-white rounded-lg border border-[#E2E8F0]">
                    Tanımlı bildirim kanalı yok.
                </div>
            ) : (
                <div className="bg-white border border-[#E2E8F0] rounded-lg divide-y divide-[#E2E8F0]">
                    {channels.map(c => (
                        <div key={c.channel_id} className="px-4 py-3 flex items-center gap-3">
                            <span className="text-2xl">{TYPE_ICONS[c.channel_type] || '🔔'}</span>
                            <div className="flex-1">
                                <div className="text-sm font-medium text-[#1E293B]">
                                    {c.channel_name}
                                    <span className="ml-2 text-[10px] bg-[#F1F5F9] text-[#475569] px-1.5 py-0.5 rounded uppercase">{c.channel_type}</span>
                                    {!c.is_enabled && <span className="ml-1 text-[10px] bg-[#FEF2F2] text-[#DC2626] px-1.5 py-0.5 rounded">devre dışı</span>}
                                </div>
                                <div className="text-xs text-[#94A3B8] mt-0.5">
                                    {[
                                        c.min_severity ? `Min: ${c.min_severity}` : null,
                                        // Kisitlama varsa gorunur olmali: kanalin sessiz
                                        // kalmasinin sebebi burasi olabilir.
                                        c.alert_codes && c.alert_codes.length > 0
                                            ? `${c.alert_codes.length} alarm tipi`
                                            : null,
                                    ].filter(Boolean).join(' · ')}
                                </div>
                            </div>
                            <button onClick={() => testMut.mutate(c.channel_id)}
                                className="text-xs px-2.5 py-1 bg-[#EFF6FF] text-[#2563EB] rounded hover:bg-[#DBEAFE]">
                                Test Gönder
                            </button>
                            <button onClick={() => setEditingChannel(c)}
                                className="text-xs px-2.5 py-1 bg-[#FEF3C7] text-[#B45309] rounded hover:bg-[#FDE68A]">
                                Düzenle
                            </button>
                            <button onClick={() => deleteMut.mutate(c.channel_id)}
                                className="text-xs px-2.5 py-1 bg-[#FEE2E2] text-[#DC2626] rounded hover:bg-[#FECACA]">
                                Sil
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {showForm && <ChannelFormModal onClose={() => setShowForm(false)} />}
            {editingChannel && <ChannelFormModal channel={editingChannel} onClose={() => setEditingChannel(null)} />}
        </div>
    );
}

function ChannelFormModal({ channel, onClose }: { channel?: NotificationChannel; onClose: () => void }) {
    const toast = useToast();
    const qc = useQueryClient();
    const isEdit = !!channel;

    // Mevcut config'ten form alanlarını çıkar
    const existingConfig: any = channel?.config && typeof channel.config === 'object'
        ? channel.config
        : (typeof channel?.config === 'string' ? (() => { try { return JSON.parse(channel.config as any); } catch { return {}; } })() : {});

    const [form, setForm] = useState({
        channel_name: channel?.channel_name ?? '',
        channel_type: (channel?.channel_type ?? 'telegram') as NotificationChannel['channel_type'],
        min_severity: channel?.min_severity ?? '',
        // Bos dizi = kisitlama yok (kanal tum alarm tiplerini alir)
        alert_codes: (channel?.alert_codes ?? []) as string[],
        // config alanları (mevcut kanaldan doldurulur)
        webhook_url: existingConfig.webhook_url ?? '',
        channel: existingConfig.channel ?? '',
        recipients: Array.isArray(existingConfig.recipients) ? existingConfig.recipients.join(', ') : (existingConfig.recipients ?? ''),
        integration_key: existingConfig.integration_key ?? '',
        url: existingConfig.url ?? '',
        bot_token: existingConfig.bot_token ?? '',
        chat_id: existingConfig.chat_id ?? '',
        webhook_method: existingConfig.method ?? 'POST',
        webhook_headers: existingConfig.headers ? JSON.stringify(existingConfig.headers, null, 2) : '{"Content-Type": "application/json"}',
        webhook_body_template: existingConfig.body_template ?? `{
  "alert_id": "{{alert_id}}",
  "severity": "{{severity}}",
  "title": "{{title}}",
  "message": "{{message}}",
  "timestamp": "{{timestamp}}"
}`,
        // Email subject + body template (V038+)
        email_from: existingConfig.from ?? '',
        email_subject_template: existingConfig.subject_template ?? '',
        email_body_template: existingConfig.body_template ?? '',
        // Teams card_template + theme_color (V038+)
        teams_theme_color: existingConfig.theme_color ?? '',
        teams_card_template: existingConfig.card_template ?? '',
    });
    const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));

    // Tespit edilen aday gruplar (birden fazla ise kullanici secsin).
    type ChatCandidate = { chat_id: string; title: string; type: string };
    const [chatCandidates, setChatCandidates] = useState<ChatCandidate[]>([]);

    // Telegram chat_id otomatik tespit: bot_token ile getUpdates cagirir,
    // bota gelen grup/kanal chat_id'lerini bulur. Tek aday varsa forma doldurur,
    // birden fazla aday varsa kullaniciya secim listesi gosterir.
    const detectMut = useMutation({
        mutationFn: () => apiPost<{ detected: ChatCandidate | null; candidates: ChatCandidate[]; hint?: string }>(
            '/adaptive-alerting/notification-channels/detect-chat',
            { bot_token: form.bot_token }
        ),
        onSuccess: (data) => {
            const list = data.candidates || [];
            if (list.length === 0) {
                setChatCandidates([]);
                toast.error(data.hint || 'Chat bulunamadi. Bota gruptan bir mesaj atip tekrar deneyin.');
            } else if (list.length === 1) {
                setChatCandidates([]);
                set('chat_id', list[0].chat_id);
                toast.success(`Bulundu: ${list[0].title} (${list[0].type}) -> ${list[0].chat_id}`);
            } else {
                // Birden fazla grup -> kullanici secsin
                setChatCandidates(list);
                toast.success(`${list.length} grup/kanal bulundu, asagidan secin.`);
            }
        },
        onError: (e: Error) => toast.error('Tespit basarisiz: ' + e.message),
    });

    const pickCandidate = (c: ChatCandidate) => {
        set('chat_id', c.chat_id);
        setChatCandidates([]);
        toast.success(`Secildi: ${c.title} -> ${c.chat_id}`);
    };

    const buildConfig = () => {
        let config: any = {};
        switch (form.channel_type) {
            case 'slack': config = { webhook_url: form.webhook_url, channel: form.channel || undefined }; break;
            case 'teams': {
                const c: any = { webhook_url: form.webhook_url };
                if (form.teams_theme_color?.trim()) c.theme_color = form.teams_theme_color.trim();
                if (form.teams_card_template?.trim()) c.card_template = form.teams_card_template.trim();
                config = c;
                break;
            }
            case 'email': {
                const c: any = { recipients: form.recipients.split(',').map((s: string) => s.trim()).filter(Boolean) };
                if (form.email_from?.trim()) c.from = form.email_from.trim();
                if (form.email_subject_template?.trim()) c.subject_template = form.email_subject_template.trim();
                if (form.email_body_template?.trim()) c.body_template = form.email_body_template.trim();
                config = c;
                break;
            }
            case 'pagerduty': config = { integration_key: form.integration_key }; break;
            case 'webhook': config = {
                url: form.url,
                method: form.webhook_method,
                headers: (() => { try { return JSON.parse(form.webhook_headers); } catch { return { 'Content-Type': 'application/json' }; } })(),
                body_template: form.webhook_body_template,
            }; break;
            case 'telegram': config = { bot_token: form.bot_token, chat_id: form.chat_id }; break;
        }
        return config;
    };

    // Secim listesi: sistemde kullanilan alarm kodlari (aciklama + kaynak ile)
    const { data: alertCodes = [] } = useQuery<AlertCodeInfo[]>({
        queryKey: ['alert-codes'],
        queryFn: () => apiGet('/adaptive-alerting/notification-channels/alert-codes'),
    });

    const [search, setSearch] = useState('');
    // Arama hem kodda hem aciklamada eslesir — kullanici kodu ezbere bilmek
    // zorunda kalmasin ("uzun sorgu" yazip long_running_query'yi bulabilsin).
    const visibleCodes = alertCodes.filter(c => {
        const q = search.trim().toLowerCase();
        if (!q) return true;
        return c.alert_code.toLowerCase().includes(q)
            || (c.description ?? '').toLowerCase().includes(q);
    });

    const saveMut = useMutation({
        mutationFn: async () => {
            const body = {
                channel_name: form.channel_name,
                channel_type: form.channel_type,
                config: buildConfig(),
                min_severity: form.min_severity || null,
            };
            // Alarm tipleri ayri endpoint'te tutuluyor (ayri tablo), bu yuzden
            // kanal kaydedildikten SONRA yaziliyor — yeni kanalda channel_id
            // ancak insert sonrasi biliniyor.
            const saved: any = isEdit
                ? await apiPut(`/adaptive-alerting/notification-channels/${channel!.channel_id}`, body)
                : await apiPost('/adaptive-alerting/notification-channels', { ...body, instance_pks: null, metric_categories: null });
            const channelId = channel?.channel_id ?? saved?.channel_id;
            if (channelId) {
                await apiPut(`/adaptive-alerting/notification-channels/${channelId}/alert-codes`,
                    { alert_codes: form.alert_codes });
            }
            return saved;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: ['channels'] });
            qc.invalidateQueries({ queryKey: ['adaptive-overview'] });
            toast.success(isEdit ? 'Kanal güncellendi' : 'Kanal eklendi');
            onClose();
        },
        onError: (e: any) => toast.error(e?.message || 'Hata'),
    });

    return (
        <Modal title={isEdit ? 'Bildirim Kanalı Düzenle' : 'Bildirim Kanalı Ekle'} onClose={onClose}>
            <div className="space-y-4">
                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Kanal Adı *</label>
                    <input value={form.channel_name} onChange={e => set('channel_name', e.target.value)}
                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                </div>
                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">Tip</label>
                    <select value={form.channel_type} onChange={e => set('channel_type', e.target.value)}
                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm">
                        <option value="slack">Slack</option>
                        <option value="teams">Microsoft Teams</option>
                        <option value="email">Email</option>
                        <option value="pagerduty">PagerDuty</option>
                        <option value="webhook">Webhook (Generic)</option>
                        <option value="telegram">Telegram</option>
                    </select>
                </div>

                {/* Tip'e göre dinamik alanlar */}
                {(form.channel_type === 'slack' || form.channel_type === 'teams') && (
                    <>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Webhook URL *
                                {form.channel_type === 'teams' && (
                                    <InfoTip text="Teams kanalında ... > Connectors > Incoming Webhook ekleyin. Oluşturulan URL'i buraya yapıştırın." className="ml-1" />
                                )}
                            </label>
                            <input value={form.webhook_url} onChange={e => set('webhook_url', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                placeholder="https://hooks.slack.com/services/..." />
                        </div>
                        {form.channel_type === 'slack' && (
                            <div>
                                <label className="block text-xs font-medium text-[#475569] mb-1">Kanal (opsiyonel)</label>
                                <input value={form.channel} onChange={e => set('channel', e.target.value)}
                                    className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                    placeholder="#alerts" />
                            </div>
                        )}
                        {form.channel_type === 'teams' && (
                            <>
                                <div>
                                    <label className="block text-xs font-medium text-[#475569] mb-1">
                                        Theme Color (opsiyonel)
                                        <InfoTip text="Kart sol kenar rengi. Boş bırakılırsa severity'ye göre (kırmızı/turuncu/mavi). Hex: FF0000" className="ml-1" />
                                    </label>
                                    <input value={form.teams_theme_color} onChange={e => set('teams_theme_color', e.target.value)}
                                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm font-mono"
                                        placeholder="0078D4" />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-[#475569] mb-1">
                                        Card Template (opsiyonel, JSON)
                                        <InfoTip text="Boş bırakılırsa default Adaptive Card kullanılır. Custom JSON yazarsan placeholder: {{title}}, {{message}}, {{severity}}, {{severity_upper}}, {{color}}" className="ml-1" />
                                    </label>
                                    <textarea value={form.teams_card_template} onChange={e => set('teams_card_template', e.target.value)}
                                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-xs font-mono"
                                        rows={6}
                                        placeholder={"{\"@type\":\"MessageCard\",\"themeColor\":\"{{color}}\",\"summary\":\"{{title}}\",\"text\":\"{{message}}\"}"} />
                                </div>
                            </>
                        )}
                    </>
                )}
                {form.channel_type === 'email' && (
                    <>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Alıcılar (virgülle ayır)
                                <InfoTip text="Email bildirimi için sunucuda SMTP ayarları gerekir. .env dosyasında PGSTAT_SMTP_HOST, PGSTAT_SMTP_PORT, PGSTAT_SMTP_USER, PGSTAT_SMTP_PASSWORD değerlerini ayarlayın. Gmail için: host=smtp.gmail.com, port=587, App Password kullanın." className="ml-1" />
                            </label>
                            <input value={form.recipients} onChange={e => set('recipients', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                placeholder="ops@example.com, dba@example.com" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                From (opsiyonel)
                                <InfoTip text="Boş bırakılırsa pgstat@localhost kullanılır. SMTP'nin izin verdiği bir from adresi yazın." className="ml-1" />
                            </label>
                            <input value={form.email_from} onChange={e => set('email_from', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                placeholder="pgstat@example.com" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Subject Template (opsiyonel)
                                <InfoTip text="Boş bırakılırsa: '[pgstat SEVERITY] title'. Placeholder: {{title}}, {{message}}, {{severity}}, {{severity_upper}}" className="ml-1" />
                            </label>
                            <input value={form.email_subject_template} onChange={e => set('email_subject_template', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm font-mono"
                                placeholder="[{{severity_upper}}] pgstat: {{title}}" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Body Template (opsiyonel)
                                <InfoTip text="Email gövdesi. Boş bırakılırsa default mesaj gönderilir. Placeholder: {{title}}, {{message}}, {{severity}}, {{severity_upper}}" className="ml-1" />
                            </label>
                            <textarea value={form.email_body_template} onChange={e => set('email_body_template', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-xs font-mono"
                                rows={5}
                                placeholder={"Severity: {{severity_upper}}\nKonu: {{title}}\n\n{{message}}\n\n— pgstat Monitoring"} />
                        </div>
                    </>
                )}
                {form.channel_type === 'pagerduty' && (
                    <div>
                        <label className="block text-xs font-medium text-[#475569] mb-1">Integration Key *</label>
                        <input value={form.integration_key} onChange={e => set('integration_key', e.target.value)}
                            className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm" />
                    </div>
                )}
                {form.channel_type === 'webhook' && (
                    <>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                URL *
                                <InfoTip text="Alert oluştuğunda HTTP isteği gönderilecek endpoint. Herhangi bir REST API, n8n, Zapier, custom endpoint olabilir." className="ml-1" />
                            </label>
                            <input value={form.url} onChange={e => set('url', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                placeholder="https://api.example.com/alerts" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">HTTP Method</label>
                            <select value={form.webhook_method} onChange={e => set('webhook_method', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm">
                                <option value="POST">POST</option>
                                <option value="PUT">PUT</option>
                                <option value="PATCH">PATCH</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Headers (JSON)
                                <InfoTip text="HTTP header'ları JSON formatında. Örn: Authorization header eklemek için {&quot;Content-Type&quot;: &quot;application/json&quot;, &quot;Authorization&quot;: &quot;Bearer TOKEN&quot;}" className="ml-1" />
                            </label>
                            <textarea value={form.webhook_headers} onChange={e => set('webhook_headers', e.target.value)}
                                rows={2}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm font-mono text-xs resize-none" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Body Template (JSON)
                                <InfoTip text="Gönderilecek JSON body. Değişkenler: {{alert_id}}, {{severity}}, {{title}}, {{message}}, {{instance_pk}}, {{timestamp}}. Değişkenler gönderim sırasında gerçek değerlerle değiştirilir." className="ml-1" />
                            </label>
                            <textarea value={form.webhook_body_template} onChange={e => set('webhook_body_template', e.target.value)}
                                rows={6}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm font-mono text-xs resize-y"
                                placeholder={'{\n  "severity": "{{severity}}",\n  "title": "{{title}}"\n}'} />
                            <div className="text-[10px] text-[#94A3B8] mt-1">
                                Değişkenler: <code className="bg-[#F1F5F9] px-1 rounded">{'{{alert_id}}'}</code> <code className="bg-[#F1F5F9] px-1 rounded">{'{{severity}}'}</code> <code className="bg-[#F1F5F9] px-1 rounded">{'{{title}}'}</code> <code className="bg-[#F1F5F9] px-1 rounded">{'{{message}}'}</code> <code className="bg-[#F1F5F9] px-1 rounded">{'{{instance_pk}}'}</code> <code className="bg-[#F1F5F9] px-1 rounded">{'{{timestamp}}'}</code>
                            </div>
                        </div>
                    </>
                )}
                {form.channel_type === 'telegram' && (
                    <>
                        {/* Adim adim kurulum rehberi */}
                        <div className="bg-[#F0F9FF] border border-[#BAE6FD] rounded-md p-3 text-xs text-[#0C4A6E] space-y-1">
                            <div className="font-semibold mb-1">Telegram kurulumu (3 adim):</div>
                            <div><b>1.</b> @BotFather'a <code>/newbot</code> yaz, bot olustur, token'i asagiya yapistir.</div>
                            <div><b>2.</b> Botu hedef <b>gruba</b> ekle (komut yetkisi icin grup onerilir; kanalda from.id gelmez). Gruba bir mesaj at.</div>
                            <div><b>3.</b> Asagidaki <b>"Chat ID Tespit Et"</b> butonuna bas — chat_id otomatik dolar.</div>
                            <div className="pt-1 text-[#0369A1]">Not: Alert susturma komutlari icin yetkili kisileri Ayarlar &gt; Telegram Komutlari'ndan allowlist'e ekle.</div>
                        </div>

                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Bot Token *
                                <InfoTip text="Telegram'da @BotFather'a /newbot yazın, bot oluşturun. Size verilen token'ı buraya yapıştırın. Örn: 123456:ABC-DEF..." className="ml-1" />
                            </label>
                            <input value={form.bot_token} onChange={e => set('bot_token', e.target.value)}
                                className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-[#475569] mb-1">
                                Chat ID *
                                <InfoTip text="Botu gruba ekleyip bir mesaj yazdiktan sonra 'Chat ID Tespit Et' butonu ile otomatik bulunur. Elle de girebilirsiniz; grup/kanal ID'leri - ile baslar." className="ml-1" />
                            </label>
                            <div className="flex gap-2">
                                <input value={form.chat_id} onChange={e => set('chat_id', e.target.value)}
                                    className="flex-1 border border-[#CBD5E1] rounded-md px-3 py-2 text-sm"
                                    placeholder="-1001234567890 veya @kanal_adi" />
                                <button type="button"
                                    onClick={() => detectMut.mutate()}
                                    disabled={!form.bot_token || detectMut.isPending}
                                    className="px-3 py-2 text-sm bg-[#3B82F6] text-white rounded-md hover:bg-[#2563EB] disabled:opacity-50 whitespace-nowrap">
                                    {detectMut.isPending ? 'Aranıyor...' : 'Chat ID Tespit Et'}
                                </button>
                            </div>
                            <p className="text-[11px] text-[#64748B] mt-1">
                                Bot token'i girip botu gruba ekledikten ve gruba bir mesaj attiktan sonra tespit butonuna bas.
                            </p>

                            {/* Birden fazla grup bulunduysa: secim listesi */}
                            {chatCandidates.length > 1 && (
                                <div className="mt-2 border border-[#FCD34D] bg-[#FFFBEB] rounded-md p-2">
                                    <div className="text-xs font-medium text-[#92400E] mb-1.5">
                                        Birden fazla grup/kanal bulundu — dogru olani sec:
                                    </div>
                                    <div className="space-y-1">
                                        {chatCandidates.map(c => (
                                            <button key={c.chat_id} type="button"
                                                onClick={() => pickCandidate(c)}
                                                className={`w-full text-left px-2 py-1.5 text-xs rounded border transition-colors ${
                                                    form.chat_id === c.chat_id
                                                        ? 'border-[#3B82F6] bg-[#EFF6FF]'
                                                        : 'border-[#E2E8F0] bg-white hover:bg-[#F8FAFC]'
                                                }`}>
                                                <span className="font-medium text-[#1E293B]">{c.title}</span>
                                                <span className="ml-2 text-[10px] bg-[#F1F5F9] text-[#475569] px-1.5 py-0.5 rounded uppercase">{c.type}</span>
                                                <span className="ml-2 font-mono text-[#64748B]">{c.chat_id}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </>
                )}

                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">
                        Minimum Severity
                        <InfoTip text="Bu kanala sadece seçilen seviye ve üstü alert'ler gönderilir. Örn: Warning+ seçerseniz info alert'leri gönderilmez. Boş bırakırsanız tüm alert'ler gönderilir." className="ml-1" />
                    </label>
                    <select value={form.min_severity} onChange={e => set('min_severity', e.target.value)}
                        className="w-full border border-[#CBD5E1] rounded-md px-3 py-2 text-sm">
                        <option value="">Hepsi</option>
                        <option value="warning">Warning+</option>
                        <option value="critical">Critical+</option>
                        <option value="emergency">Emergency</option>
                    </select>
                </div>

                {/* Alarm tipi filtresi: severity SEVIYEYE, bu TIPE gore filtreler.
                    Ikisi birlikte calisir. Hicbiri secilmezse kisitlama yoktur —
                    "hicbirini alma" degil "hepsini al" demektir, bu yuzden bos
                    durum acikca yaziyor. */}
                <div>
                    <label className="block text-xs font-medium text-[#475569] mb-1">
                        Alarm Tipleri
                        <InfoTip text="Bu kanalın hangi alarm tiplerini alacağını sınırlar. Hiçbiri seçilmezse kanal tüm tipleri alır. Minimum Severity ile birlikte çalışır: her ikisini de geçen alarmlar gönderilir." className="ml-1" />
                    </label>
                    {alertCodes.length === 0 ? (
                        <div className="text-xs text-[#94A3B8] py-2">Alarm tipi listesi yükleniyor…</div>
                    ) : (
                        <div className="border border-[#CBD5E1] rounded-md overflow-hidden">
                            {/* Ust serit: durum + toplu islemler + arama */}
                            <div className="bg-[#F8FAFC] border-b border-[#E2E8F0] px-2.5 py-2 space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                    <span className={`text-xs font-medium ${form.alert_codes.length === 0 ? 'text-[#059669]' : 'text-[#334155]'}`}>
                                        {form.alert_codes.length === 0
                                            ? 'Tüm alarm tipleri gönderilir'
                                            : `${form.alert_codes.length} / ${alertCodes.length} tip seçili`}
                                    </span>
                                    <div className="flex items-center gap-1.5">
                                        <button type="button"
                                            onClick={() => set('alert_codes', visibleCodes.map(c => c.alert_code))}
                                            className="text-[11px] px-2 py-0.5 rounded border border-[#CBD5E1] text-[#475569] hover:bg-white">
                                            {search ? 'Görünenleri seç' : 'Tümünü seç'}
                                        </button>
                                        <button type="button" onClick={() => set('alert_codes', [])}
                                            disabled={form.alert_codes.length === 0}
                                            className="text-[11px] px-2 py-0.5 rounded border border-[#CBD5E1] text-[#475569] hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed">
                                            Temizle
                                        </button>
                                    </div>
                                </div>
                                <input type="search" value={search} onChange={e => setSearch(e.target.value)}
                                    placeholder="Alarm tipi ara…"
                                    className="w-full border border-[#CBD5E1] rounded px-2 py-1 text-xs" />
                            </div>

                            <div className="max-h-56 overflow-y-auto">
                                {visibleCodes.length === 0 ? (
                                    <div className="text-xs text-[#94A3B8] px-2.5 py-3">Eşleşen alarm tipi yok.</div>
                                ) : (
                                    // Kaynaga gore gruplu: sistem/adaptive/kural alarmlari
                                    // farkli seyler, karisik tek liste okunmuyor.
                                    CODE_GROUPS.map(group => {
                                        const rows = visibleCodes.filter(c => codeGroupOf(c) === group.key);
                                        if (rows.length === 0) return null;
                                        const allChecked = rows.every(r => form.alert_codes.includes(r.alert_code));
                                        return (
                                            <div key={group.key}>
                                                <div className="flex items-center justify-between bg-[#F1F5F9] px-2.5 py-1 sticky top-0">
                                                    <span className="text-[11px] font-semibold text-[#475569]">
                                                        {group.label}
                                                        <span className="ml-1 font-normal text-[#94A3B8]">({rows.length})</span>
                                                    </span>
                                                    <button type="button"
                                                        onClick={() => {
                                                            const keys = rows.map(r => r.alert_code);
                                                            set('alert_codes', allChecked
                                                                ? form.alert_codes.filter(c => !keys.includes(c))
                                                                : Array.from(new Set([...form.alert_codes, ...keys])));
                                                        }}
                                                        className="text-[11px] text-[#3B82F6] hover:underline">
                                                        {allChecked ? 'kaldır' : 'seç'}
                                                    </button>
                                                </div>
                                                {rows.map(c => (
                                                    <label key={c.alert_code}
                                                        className="flex items-start gap-2 px-2.5 py-1.5 cursor-pointer hover:bg-[#F8FAFC] border-b border-[#F1F5F9] last:border-0">
                                                        <input type="checkbox" className="mt-0.5"
                                                            checked={form.alert_codes.includes(c.alert_code)}
                                                            onChange={e => set('alert_codes',
                                                                e.target.checked
                                                                    ? [...form.alert_codes, c.alert_code]
                                                                    : form.alert_codes.filter(x => x !== c.alert_code))} />
                                                        <span className="min-w-0 flex-1">
                                                            <span className="flex items-center gap-1.5">
                                                                <span className="font-mono text-xs text-[#334155] truncate">{c.alert_code}</span>
                                                                {c.last_severity && (
                                                                    <span className={`text-[10px] px-1 py-px rounded ${SEVERITY_STYLES[c.last_severity] ?? 'bg-[#F1F5F9] text-[#64748B]'}`}>
                                                                        {c.last_severity}
                                                                    </span>
                                                                )}
                                                                {Number(c.count_30d) > 0 && (
                                                                    <span className="text-[10px] text-[#94A3B8]">30g: {c.count_30d}</span>
                                                                )}
                                                            </span>
                                                            {c.description && (
                                                                <span className="block text-[11px] text-[#94A3B8] leading-snug">{c.description}</span>
                                                            )}
                                                        </span>
                                                    </label>
                                                ))}
                                            </div>
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    )}
                </div>
            </div>
            <ModalFooter onClose={onClose} onSave={() => saveMut.mutate()} busy={saveMut.isPending} />
        </Modal>
    );
}
