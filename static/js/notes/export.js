(function () {
    let html2pdfLoader = null;

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
            document.head.appendChild(script);
        });
    }

    async function ensurePdfLibrary() {
        if (typeof window.html2pdf === 'function' || window.jspdf?.jsPDF) return;

        if (!html2pdfLoader) {
            html2pdfLoader = loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js');
        }

        await html2pdfLoader;
    }

    function normalizeTitle(title) {
        return (title || 'Untitled').trim() || 'Untitled';
    }

    function sanitizeFilename(value) {
        return value.replace(/[^a-zA-Z0-9._-]+/g, '_');
    }

    function inlineContentToMarkdown(item) {
        if (typeof item === 'string') return item;
        if (item?.type === 'link') {
            const label = parseBlockContent(item.content);
            return item.href ? `[${label}](${item.href})` : label;
        }
        if (item?.type === 'inlineImage') {
            const props = item.props || {};
            const alt = String(props.alt || 'Image').replaceAll(']', '\\]');
            return props.url ? `![${alt}](${props.url})` : alt;
        }
        if (item && typeof item.text === 'string') return item.text;
        return '';
    }

    function parseBlockContent(contentNode) {
        if (!Array.isArray(contentNode)) return '';
        return contentNode
            .map((item) => inlineContentToMarkdown(item))
            .join('')
            .trim();
    }

    function toBlockArray(blockNoteJson) {
        if (Array.isArray(blockNoteJson)) return blockNoteJson;

        if (typeof blockNoteJson === 'string') {
            const trimmed = blockNoteJson.trim();
            if (!trimmed) return [];

            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) return parsed;
            } catch (error) {
                return [
                    {
                        type: 'paragraph',
                        content: [{ text: trimmed }],
                    },
                ];
            }
        }

        return [];
    }

    function blockToMarkdown(block) {
        const text = parseBlockContent(block?.content);

        switch (block?.type) {
            case 'heading': {
                if (!text) return '';
                const level = Math.min(Math.max(Number(block.props?.level || 1), 1), 6);
                return `${'#'.repeat(level)} ${text}`;
            }
            case 'bulletListItem':
                if (!text) return '';
                return `- ${text}`;
            case 'numberedListItem':
                if (!text) return '';
                return `1. ${text}`;
            case 'checkListItem': {
                if (!text) return '';
                const checked = block.props?.checked ? 'x' : ' ';
                return `- [${checked}] ${text}`;
            }
            case 'quote':
                if (!text) return '';
                return `> ${text}`;
            case 'codeBlock':
                if (!text) return '';
                return `\`\`\`\n${text}\n\`\`\``;
            case 'callout':
                return text ? `> [!NOTE] ${text}` : '';
            case 'divider':
            case 'pageBreak':
            case 'horizontalRule':
                return '---';
            case 'bookmark': {
                const title = block.props?.title || block.props?.url || 'Bookmark';
                const url = block.props?.url || '';
                return url ? `[${title}](${url})` : title;
            }
            case 'image': {
                const url = block.props?.url || '';
                const caption = block.props?.caption || block.props?.name || 'Image';
                return url ? `![${caption}](${url})` : caption;
            }
            case 'video': {
                const url = block.props?.url || '';
                const caption = block.props?.caption || block.props?.name || 'Video';
                return url ? `[${caption}](${url})` : caption;
            }
            default:
                return text || '';
        }
    }

    function blockNoteJsonToMarkdown(blockNoteJson) {
        const blocks = toBlockArray(blockNoteJson);
        if (!blocks.length) return '';

        return blocks
            .map((block) => blockToMarkdown(block))
            .filter(Boolean)
            .join('\n\n');
    }

    function blockNoteJsonToPlainText(blockNoteJson) {
        const markdown = blockNoteJsonToMarkdown(blockNoteJson);
        return markdown
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/^#{1,6}\s+/gm, '')
            .replace(/^>\s+/gm, '')
            .replace(/^-\s\[[ x]\]\s+/gm, '')
            .replace(/^-\s+/gm, '')
            .replace(/^1\.\s+/gm, '')
            .replace(/\`\`\`/g, '')
            .trim();
    }

    function downloadBlob(blob, filename) {
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    function exportNoteJsonToTxt(blockNoteJson, title) {
        const text = blockNoteJsonToPlainText(blockNoteJson);
        const fileBase = sanitizeFilename(normalizeTitle(title));
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        downloadBlob(blob, `${fileBase}.txt`);
    }

    async function exportEditorContainerToPdf(container, title) {
        if (!container) throw new Error('Missing editor container for PDF export.');

        await ensurePdfLibrary();

        const fileBase = sanitizeFilename(normalizeTitle(title));

        if (typeof window.html2pdf === 'function') {
            await window
                .html2pdf()
                .set({
                    margin: 10,
                    filename: `${fileBase}.pdf`,
                    image: { type: 'jpeg', quality: 0.98 },
                    html2canvas: { scale: 2, useCORS: true },
                    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                })
                .from(container)
                .save();
            return;
        }

        const JsPdfCtor = window.jspdf?.jsPDF;
        if (JsPdfCtor) {
            const pdf = new JsPdfCtor({ unit: 'pt', format: 'a4' });
            await pdf.html(container, {
                x: 24,
                y: 24,
                width: 547,
                windowWidth: Math.max(container.scrollWidth, 800),
            });
            pdf.save(`${fileBase}.pdf`);
            return;
        }

        throw new Error('PDF export library missing. Load html2pdf.js or jsPDF first.');
    }

    async function exportNoteJsonToPdf(blockNoteJson, title) {
        const markdown = blockNoteJsonToMarkdown(blockNoteJson);
        const wrapper = document.createElement('article');
        wrapper.style.padding = '20px';
        wrapper.style.background = '#ffffff';
        wrapper.style.color = '#111111';
        wrapper.style.fontFamily = 'Arial, sans-serif';
        wrapper.style.fontSize = '14px';
        wrapper.style.lineHeight = '1.5';

        const heading = document.createElement('h1');
        heading.textContent = normalizeTitle(title);
        heading.style.fontSize = '24px';
        heading.style.marginBottom = '12px';

        const body = document.createElement('pre');
        body.textContent = markdown || '';
        body.style.whiteSpace = 'pre-wrap';
        body.style.margin = '0';

        wrapper.appendChild(heading);
        wrapper.appendChild(body);

        wrapper.style.position = 'fixed';
        wrapper.style.left = '-9999px';
        wrapper.style.top = '0';
        wrapper.style.width = '800px';

        document.body.appendChild(wrapper);
        try {
            await exportEditorContainerToPdf(wrapper, title);
        } finally {
            wrapper.remove();
        }
    }

    window.NotesExport = {
        blockNoteJsonToMarkdown,
        blockNoteJsonToPlainText,
        exportNoteJsonToTxt,
        exportEditorContainerToPdf,
        exportNoteJsonToPdf,
    };
})();
