/**
 * Bilgilendirme banner'i — bir tab'in gosterdigi verinin "delta" mi yoksa
 * "anlik snapshot" mi oldugunu kullaniciya net soyler.
 *
 * Yanilsama: Kullanici '5 satir' gorunce 5 ayri olay zanneder; halbuki delta
 * tablolarda her satir bir periyot ozetidir (60sn cycle ise 60 saniyenin
 * toplami), snapshot tablolarda ise tek bir anlik fotograftir.
 */
interface Props {
    kind: 'delta' | 'snapshot';
    description: string;
}

export default function DataKindBanner({ kind, description }: Props) {
    const isDelta = kind === 'delta';
    const bg = isDelta ? 'bg-[#EFF6FF] border-[#BFDBFE]' : 'bg-[#FEF9C3] border-[#FDE68A]';
    const text = isDelta ? 'text-[#1D4ED8]' : 'text-[#A16207]';
    const label = isDelta ? 'DELTA (periyot toplami)' : 'ANLIK SNAPSHOT';
    const icon = isDelta ? '📊' : '📸';

    return (
        <div className={`${bg} ${text} border rounded-md px-3 py-2 mb-3 text-xs flex items-start gap-2`}>
            <span className="text-base leading-none">{icon}</span>
            <div>
                <div className="font-semibold mb-0.5">{label}</div>
                <div className="opacity-90">{description}</div>
            </div>
        </div>
    );
}
