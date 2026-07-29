const AI_BRAND = 'Nigga Chain Ai Layer 2';

function formatAiResponse(text, label = AI_BRAND) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').trim().split('\n');
    const formatted = [];
    let inCodeBlock = false;

    for (const rawLine of lines) {
        if (rawLine.trimStart().startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            formatted.push(rawLine.trimEnd());
            continue;
        }

        if (inCodeBlock) {
            formatted.push(rawLine.trimEnd());
            continue;
        }

        let line = rawLine.trim();
        if (!line) {
            if (formatted.at(-1) !== '') formatted.push('');
            continue;
        }

        line = line
            .replace(/^#{1,6}\s+(.+)$/, '*$1*')
            .replace(/\*\*(.+?)\*\*/g, '*$1*')
            .replace(/__(.+?)__/g, '_$1_')
            .replace(/^[-*]\s+/, '• ');
        formatted.push(line);
    }

    const body = formatted.join('\n').trim();
    return `✨ *${label}*\n\n${body}`;
}

module.exports = { AI_BRAND, formatAiResponse };
