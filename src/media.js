const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const mime = require('mime-types');

async function downloadMedia(message, type, maxBytes = Infinity) {
    if (message?.url && typeof message.url === 'string' && message.url.includes('a.whatsapp.net')) {
        message.url = message.url.replace('a.whatsapp.net', 'mmg.whatsapp.net');
    }

    const stream = await downloadContentFromMessage(message, type);
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of stream) {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) throw new Error('AI_MEDIA_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, totalBytes);
}

function getExtension(mimetype) {
    return mime.extension(mimetype) || 'bin';
}

async function sendLongText(sock, jid, text, quoted) {
    const chunks = text.match(/[\s\S]{1,3500}/g) || [];
    for (const chunk of chunks) {
        await sock.sendMessage(jid, { text: chunk }, { quoted });
    }
}

module.exports = { downloadMedia, getExtension, sendLongText };
