const { AI_CONFIG } = require('../config');
const { normalizeUserJid } = require('../identifiers');
const { downloadMedia, sendLongText } = require('../media');
const { getRealMessage } = require('../whatsapp/message-utils');
const { generateImage, generateSpeech, generateVideo, requestAi, transcribeAudio } = require('./client');
const { getAiCommand } = require('./commands');
const { AI_BRAND, formatAiResponse } = require('./format');
const { findAiMedia, prepareAiMediaInput } = require('./media-input');

const activeRequests = new Set();

function getAiConversationKey(remoteJid, senderJid) {
    return remoteJid.endsWith('@g.us') ? `${remoteJid}:${senderJid}` : remoteJid;
}

function isAiAuthorized({ aiWhitelist, allowGroups, groupWhitelist, isFromMe, remoteJid, senderJid }) {
    if (remoteJid.endsWith('@g.us')) {
        return allowGroups && Boolean(groupWhitelist?.includes(remoteJid));
    }
    return isFromMe || Boolean(senderJid && aiWhitelist.includes(senderJid));
}

async function handleAiAccessCommand({ aiState, args = [], command, target, sock, myJid, whitelist }) {
    if (command === 'ai' || command === 'aistatus' || command === 'aion' || command === 'aioff') {
        const action = (command === 'aion' ? 'on' : command === 'aioff' ? 'off' : args[1] || '').toLowerCase();

        if (action === 'on' || action === 'enable') {
            aiState?.setEnabled(true);
            await sock.sendMessage(myJid, {
                text: '✅ *AI Assistant is ON.*\nFitur AI sekarang aktif dan dapat digunakan oleh user/grup yang terdaftar di whitelist.'
            });
            return true;
        }

        if (action === 'off' || action === 'disable') {
            aiState?.setEnabled(false);
            await sock.sendMessage(myJid, {
                text: '❌ *AI Assistant is OFF.*\nFitur AI sekarang dinonaktifkan secara global.'
            });
            return true;
        }

        const isEnabled = aiState ? aiState.isEnabled() : true;
        const statusText = isEnabled ? '✅ ON' : '❌ OFF';
        await sock.sendMessage(myJid, {
            text: `🤖 *AI Assistant Status:* ${statusText}\n\nKetik */ai on* (atau *.ai on*) untuk mengaktifkan, */ai off* (atau *.ai off*) untuk menonaktifkan.`
        });
        return true;
    }

    if (command === 'aiadd') {
        const aiTarget = normalizeUserJid(target);
        if (!aiTarget) {
            await sock.sendMessage(myJid, { text: '⚠️ Gunakan `.aiadd <nomor/JID>` atau reply pesan user. Group tidak bisa di-whitelist.' });
        } else if (whitelist.add(aiTarget)) {
            await sock.sendMessage(myJid, { text: `✅ AI access diberikan ke *${aiTarget}*.` });
        } else {
            await sock.sendMessage(myJid, { text: `ℹ️ *${aiTarget}* sudah punya AI access.` });
        }
        return true;
    }

    if (command === 'aidel') {
        const aiTarget = normalizeUserJid(target);
        if (!aiTarget) {
            await sock.sendMessage(myJid, { text: '⚠️ Gunakan `.aidel <nomor/JID>` atau reply pesan user.' });
        } else {
            whitelist.remove(aiTarget);
            await sock.sendMessage(myJid, { text: `❌ AI access dicabut dari *${aiTarget}*.` });
        }
        return true;
    }

    if (command === 'ailist') {
        const entries = whitelist.entries();
        const listText = entries.length > 0 ? entries.map(id => `- ${id}`).join('\n') : 'AI whitelist kosong.';
        const isEnabled = aiState ? aiState.isEnabled() : true;
        const statusText = isEnabled ? '✅ ON' : '❌ OFF';
        await sock.sendMessage(myJid, { text: `🤖 *AI Assistant Status:* ${statusText}\n\n📋 *AI Whitelist:*\n${listText}` });
        return true;
    }

    return false;
}

async function handleAiMessage({
    aiHistory,
    aiRateLimiter,
    aiState,
    aiWhitelist,
    content,
    contextInfo,
    isFromMe,
    isViewOnce,
    msg,
    myJid,
    realMsg,
    remoteJid,
    sock,
    upsertType,
    groupWhitelist
}) {
    if (remoteJid === 'status@broadcast' || isViewOnce) return false;

    const quotedRealMsg = getRealMessage(contextInfo?.quotedMessage);
    const inputMedia = findAiMedia(realMsg, quotedRealMsg);
    const isGroup = remoteJid.endsWith('@g.us');
    const autoMediaCommand = inputMedia && !isGroup && !isFromMe
        ? { name: 'ai', prompt: '' }
        : null;
    const explicitCommand = getAiCommand(content);
    const command = explicitCommand || autoMediaCommand;
    if (!command || upsertType !== 'notify') return false;

    const senderJid = normalizeUserJid(isFromMe ? myJid : (msg.key.participant || remoteJid));
    const conversationKey = getAiConversationKey(remoteJid, senderJid);

    if (!isAiAuthorized({
        aiWhitelist,
        allowGroups: AI_CONFIG.allowGroups,
        groupWhitelist,
        isFromMe,
        remoteJid,
        senderJid
    })) {
        if (!explicitCommand) return false;
        console.warn(`[AI] Denied request from ${senderJid || 'unknown'} in ${remoteJid}`);
        if (isGroup && (isFromMe || (senderJid && aiWhitelist.includes(senderJid)))) {
            const text = AI_CONFIG.allowGroups
                ? '⚠️ Group ini belum masuk whitelist owner.'
                : '⚠️ AI hanya aktif di chat pribadi.';
            await sock.sendMessage(remoteJid, { text }, { quoted: msg });
        }
        return true;
    }

    if (aiState && typeof aiState.isEnabled === 'function' && !aiState.isEnabled()) {
        if (explicitCommand) {
            console.warn(`[AI] Ignored request - AI Assistant is disabled by owner`);
        }
        return false;
    }

    const rateLimit = aiRateLimiter.check(senderJid || conversationKey);
    if (!rateLimit.allowed) {
        console.warn(`[AI] Rate limited ${senderJid || 'unknown'} (${rateLimit.scope})`);
        if (rateLimit.notify) {
            const seconds = Math.ceil(rateLimit.retryAfterMs / 1000);
            await sock.sendMessage(remoteJid, {
                text: `⏳ *${AI_BRAND}*\n\nTerlalu banyak request. Coba lagi dalam ${seconds} detik.`
            }, { quoted: msg });
        }
        return true;
    }

    const inputAudio = realMsg?.audioMessage || quotedRealMsg?.audioMessage;
    const promptRequired = command.name !== 'transcribe' && !(command.name === 'ai' && inputMedia);

    if (command.name === 'ai' && /^(reset|clear)$/i.test(command.prompt)) {
        const cleared = aiHistory.clear(conversationKey);
        const text = cleared
            ? `🧹 *${AI_BRAND}*\n\nMemori percakapan di chat ini sudah dihapus.`
            : '❌ Memori gagal dihapus. Cek log server.';
        await sock.sendMessage(remoteJid, { text }, { quoted: msg });
        return true;
    }

    if (promptRequired && !command.prompt) {
        await sock.sendMessage(remoteJid, { text: 'Gunakan `!ai`, `!image`, `!voice`, atau `!video` diikuti prompt. `!transcribe` harus me-reply voice note.' }, { quoted: msg });
        return true;
    }

    if (command.prompt.length > AI_CONFIG.maxPromptChars) {
        await sock.sendMessage(remoteJid, { text: `⚠️ Prompt terlalu panjang. Maksimal ${AI_CONFIG.maxPromptChars} karakter.` }, { quoted: msg });
        return true;
    }

    const modelKeys = { ai: 'model', image: 'imageModel', voice: 'ttsModel', transcribe: 'sttModel', video: 'videoModel' };
    if (!AI_CONFIG.baseUrl || !AI_CONFIG.apiKey || !AI_CONFIG[modelKeys[command.name]]) {
        await sock.sendMessage(remoteJid, { text: `⚠️ Fitur *${command.name}* belum dikonfigurasi oleh owner.` }, { quoted: msg });
        return true;
    }

    if (activeRequests.has(senderJid)) {
        await sock.sendMessage(remoteJid, { text: '⏳ Request sebelumnya masih diproses.' }, { quoted: msg });
        return true;
    }

    activeRequests.add(senderJid);
    try {
        if (command.name === 'ai') {
            const prepared = await prepareAiMediaInput(inputMedia, command.prompt, AI_CONFIG);
            const userPrompt = prepared.prompt;
            const answer = await requestAi(userPrompt, AI_CONFIG, prepared.attachments, aiHistory.get(conversationKey));
            await sendLongText(sock, remoteJid, formatAiResponse(answer), msg);
            aiHistory.append(conversationKey, userPrompt, answer);
        } else if (command.name === 'image') {
            const image = await generateImage(command.prompt);
            await sock.sendMessage(remoteJid, { image: image.buffer, mimetype: image.mimetype, caption: command.prompt.slice(0, 1000) }, { quoted: msg });
        } else if (command.name === 'voice') {
            const speech = await generateSpeech(command.prompt);
            const isVoiceNote = speech.mimetype.includes('ogg') || speech.mimetype.includes('opus');
            await sock.sendMessage(remoteJid, { audio: speech.buffer, mimetype: speech.mimetype, ptt: isVoiceNote }, { quoted: msg });
        } else if (command.name === 'transcribe') {
            if (!inputAudio) {
                await sock.sendMessage(remoteJid, { text: '⚠️ Reply voice note atau audio dengan `!transcribe`.' }, { quoted: msg });
                return true;
            }
            const buffer = await downloadMedia(inputAudio, 'audio', AI_CONFIG.mediaMaxBytes);
            const transcript = await transcribeAudio(buffer, inputAudio.mimetype || 'audio/ogg');
            await sendLongText(sock, remoteJid, formatAiResponse(transcript, `${AI_BRAND} · Transkripsi`), msg);
        } else if (command.name === 'video') {
            await sock.sendMessage(remoteJid, { text: '🎬 Video sedang dibuat. Proses bisa beberapa menit.' }, { quoted: msg });
            const video = await generateVideo(command.prompt);
            await sock.sendMessage(remoteJid, { video: video.buffer, mimetype: video.mimetype, caption: command.prompt.slice(0, 1000) }, { quoted: msg });
        }
    } catch (error) {
        console.error(`[AI] ${command.name} failed for ${senderJid}: ${error.message}`);
        const message = error.message === 'AI_MEDIA_TOO_LARGE'
            ? `❌ Media melebihi batas ${Math.floor(AI_CONFIG.mediaMaxBytes / 1024 / 1024)} MB.`
            : error.message === 'AI_VIDEO_ANALYSIS_UNAVAILABLE'
                ? '❌ Video belum bisa dianalisis. Pastikan `ffmpeg` tersedia atau konfigurasi model STT.'
            : '❌ AI sedang gagal memproses request. Coba lagi nanti.';
        await sock.sendMessage(remoteJid, { text: message }, { quoted: msg });
    } finally {
        activeRequests.delete(senderJid);
    }

    return true;
}

module.exports = { getAiConversationKey, handleAiAccessCommand, handleAiMessage, isAiAuthorized };
