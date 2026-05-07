/**
 * PDF İndir butonu — window.print() çağırır, tarayıcı "Save as PDF" diyaloğu açar.
 * Print CSS (globals.css içinde) sidebar/butonları gizler, tabloyu sayfaya sığdırır.
 *
 * Kullanım:
 *   <PrintButton title="Açık Alertler" />
 * Sayfa basılırken document.title kullanılır (tarayıcı dosya adı için).
 */
interface Props {
    title?: string;
    label?: string;
    className?: string;
}

export default function PrintButton({ title, label = '🖨️ PDF İndir', className }: Props) {
    const handlePrint = () => {
        const original = document.title;
        if (title) {
            // Tarayıcı print diyaloğunda dosya adı için title geçici değiştirilir
            const date = new Date().toISOString().slice(0, 10);
            document.title = `pgstat - ${title} - ${date}`;
        }
        // setTimeout: title değişiminin tarayıcıya yansıması için
        setTimeout(() => {
            window.print();
            document.title = original;
        }, 50);
    };

    return (
        <button onClick={handlePrint}
            className={className || "px-3 py-1.5 bg-[#3B82F6] text-white text-sm rounded-md hover:bg-[#2563EB] print:hidden"}>
            {label}
        </button>
    );
}
