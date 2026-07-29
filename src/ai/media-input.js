const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { downloadMedia, getExtension } = require('../media');
const { transcribeAudio } = require('./client');

const execFileAsync = promisify(execFile);
const MEDIA_TYPES = [
    ['imageMessage', 'image'],
    ['stickerMessage', 'sticker'],
    ['audioMessage', 'audio'],
    ['videoMessage', 'video'],
    ['documentMessage', 'document']
];
const DEFAULT_PROMPTS = {
    image: 'Jelaskan gambar ini dan tanggapi bagian yang penting.',
    sticker: 'Jelaskan isi atau konteks stiker ini.',
    audio: 'Dengarkan audio ini lalu berikan respons yang relevan.',
    video: 'Jelaskan isi video ini dan tanggapi bagian yang penting.',
    document: 'Baca dokumen ini lalu rangkum poin pentingnya.'
};

function findMessageMedia(message) {
    for (const [key, type] of MEDIA_TYPES) {
        if (message?.[key]) return { data: message[key], type };
    }
    return null;
}

function findAiMedia(realMessage, quotedMessage) {
    return findMessageMedia(realMessage) || findMessageMedia(quotedMessage);
}

function appendMediaText(prompt, label, text, maxChars) {
    if (!text) return prompt;
    return `${prompt}\n\n[${label}]\n${text.slice(0, maxChars)}`;
}

async function extractVideoPreview(buffer, mimetype) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-ai-video-'));
    const inputPath = path.join(directory, `input.${getExtension(mimetype)}`);
    const outputPath = path.join(directory, 'preview.jpg');
    try {
        await fs.writeFile(inputPath, buffer);
        await execFileAsync('ffmpeg', [
            '-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
            '-vf', 'thumbnail=100,scale=1280:-2', '-frames:v', '1', outputPath
        ], { timeout: 30000 });
        return await fs.readFile(outputPath);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}

async function tryTranscription(buffer, mimetype, config) {
    if (!config.sttModel) return '';
    try {
        return await transcribeAudio(buffer, mimetype, config);
    } catch (error) {
        console.warn(`[AI] Media transcription skipped: ${error.message}`);
        return '';
    }
}

async function prepareAiMediaInput(input, requestedPrompt, config) {
    if (!input) return { attachments: [], prompt: requestedPrompt };

    const prompt = requestedPrompt || DEFAULT_PROMPTS[input.type];
    const mimetype = input.data.mimetype || 'application/octet-stream';
    const buffer = await downloadMedia(input.data, input.type, config.mediaMaxBytes);

    if (input.type === 'image' || input.type === 'sticker') {
        return { prompt, attachments: [{ kind: 'image', buffer, mimetype }] };
    }

    if (input.type === 'audio') {
        const transcript = await tryTranscription(buffer, mimetype, config);
        return {
            prompt: appendMediaText(prompt, 'Transkripsi audio', transcript, config.maxPromptChars),
            attachments: [{ kind: 'audio', buffer, mimetype }]
        };
    }

    if (input.type === 'video') {
        const transcriptPromise = tryTranscription(buffer, mimetype, config);
        const previewPromise = extractVideoPreview(buffer, mimetype).catch(error => {
            console.warn(`[AI] Video preview skipped: ${error.message}`);
            return null;
        });
        const [transcript, preview] = await Promise.all([transcriptPromise, previewPromise]);
        if (!transcript && !preview) throw new Error('AI_VIDEO_ANALYSIS_UNAVAILABLE');
        return {
            prompt: appendMediaText(prompt, 'Transkripsi audio video', transcript, config.maxPromptChars),
            attachments: preview ? [{ kind: 'image', buffer: preview, mimetype: 'image/jpeg' }] : []
        };
    }

    if (mimetype.startsWith('text/') || ['application/json', 'application/xml'].includes(mimetype)) {
        return {
            prompt: appendMediaText(prompt, `Isi ${input.data.fileName || 'dokumen'}`, buffer.toString('utf8'), config.maxPromptChars),
            attachments: []
        };
    }

    return {
        prompt,
        attachments: [{
            kind: 'file',
            buffer,
            mimetype,
            filename: path.basename(input.data.fileName || `document.${getExtension(mimetype)}`)
        }]
    };
}

module.exports = { DEFAULT_PROMPTS, findAiMedia, prepareAiMediaInput };
