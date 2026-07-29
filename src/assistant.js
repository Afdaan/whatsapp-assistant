const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs-extra');
const qrcode = require('qrcode-terminal');
const { handleAiMessage } = require('./ai/handler');
const {
    AI_WHITELIST_PATH,
    AUTH_DIR,
    DELETED_MEDIA_DIR,
    MAX_CACHE_SIZE,
    MSG_CACHE_PATH,
    WHITELIST_PATH
} = require('./config');
const { normalizeUserJid } = require('./identifiers');
const { downloadMedia } = require('./media');
const { createMessageCache, createWhitelistStore } = require('./storage');
const { handleAntiDelete, handleStatus, handleViewOnce } = require('./whatsapp/content-handlers');
const { checkIsViewOnce, getContextInfo, getMessageContent, getMyJid, getRealMessage } = require('./whatsapp/message-utils');
const { handleOwnerCommand } = require('./whatsapp/owner-commands');

const logger = pino({ level: 'silent' });

fs.ensureDirSync(DELETED_MEDIA_DIR);

const whitelist = createWhitelistStore(WHITELIST_PATH);
const aiWhitelist = createWhitelistStore(AI_WHITELIST_PATH, normalizeUserJid);
const msgCache = createMessageCache(MSG_CACHE_PATH, MAX_CACHE_SIZE);

setInterval(() => msgCache.save(), 10000).unref();
setInterval(() => {
    console.log(`💓 [Heartbeat] Assistant is active. Cache size: ${msgCache.size()}/${MAX_CACHE_SIZE} messages.`);
}, 60000).unref();
async function startAssistant() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`Using Baileys v${version.join('.')}${isLatest ? '' : ' (outdated)'}`);

    const sock = makeWASocket({
        version,
        logger,
        auth: state,
        printQRInTerminal: true,
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(
                message.buttonsMessage ||
                message.templateMessage ||
                message.listMessage
            );
            if (requiresPatch) {
                message = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadata: {},
                                deviceListMetadataVersion: 2
                            },
                            ...message
                        }
                    }
                };
            }
            return message;
        }
    });



    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('Scan the QR code below:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log('Connection closed. Reconnecting...', shouldReconnect);
            if (shouldReconnect) startAssistant();
        } else if (connection === 'open') {
            console.log('WhatsApp Assistant is online!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const msgId = msg.key.id;

        const realMsg = getRealMessage(msg.message);
        


        const isViewOnce = checkIsViewOnce(msg.message);
        const isProtocol = !!msg.message.protocolMessage;
        
        const myJid = getMyJid(sock);
        const isFromMe = msg.key.fromMe;
        
        // Extract text content from the unwrapped message
        const content = getMessageContent(realMsg);
        const contextInfo = getContextInfo(realMsg);

        // Only cache actual content, not protocol messages
        if (!isProtocol) {
            msgCache.set(msgId, JSON.parse(JSON.stringify(msg)));
        }

        if (await handleOwnerCommand({
            aiWhitelist,
            content,
            contextInfo,
            isFromMe,
            msgCache,
            myJid,
            remoteJid,
            sock,
            whitelist
        })) return;

        if (await handleAiMessage({
            aiWhitelist,
            content,
            contextInfo,
            isFromMe,
            msg,
            myJid,
            realMsg,
            remoteJid,
            sock,
            upsertType: m.type,
            groupWhitelist: whitelist
        })) return;
        const quotedMessage = contextInfo?.quotedMessage;

        // --- View Once Handling ---
        const isViewOncePlaceholder = content.toLowerCase().includes('view once message') && content.toLowerCase().includes('added privacy');
        
        if (isViewOnce || isViewOncePlaceholder) {
            const isPrivate = !remoteJid.endsWith('@g.us') && remoteJid !== 'status@broadcast';
            if (isPrivate || whitelist.includes(remoteJid)) {
                if (isViewOncePlaceholder) {
                    console.log(`🔒 [View Once Blocked] Placeholder received from ${remoteJid}`);
                    const senderJid = msg.key.participant || remoteJid;
                    const senderName = msg.pushName || senderJid.split('@')[0];
                    await sock.sendMessage(myJid, {
                        text: `🔒 *VIEW ONCE MASUK*\n👤 *Dari:* ${senderName}\n\n_Buka HP-mu, lalu balas (reply) foto ini dengan tulisan apa saja (contoh: "a"). Bot akan mencoba menyedot fotonya otomatis!_`
                    });
                } else {
                    console.log(`📸 [View Once] Received real payload in ${remoteJid}`);
                    await handleViewOnce(sock, msg);
                }
            }
        }

        // --- Auto-Scrape via Reply (No Command Needed) ---
        // If user replies to a message, check if the quoted message itself is marked as viewOnce
        if (isFromMe && quotedMessage && content.toLowerCase() !== '.scrap') {
            const quotedRealMsg = getRealMessage(quotedMessage);
            const mediaMsg = quotedRealMsg?.imageMessage || quotedRealMsg?.videoMessage;
            
            // If WA preserves the viewOnce flag in the quoted payload, we can safely auto-scrape
            if (mediaMsg && mediaMsg.viewOnce === true) {
                console.log(`\n🎉 [AUTO-SCRAP] Detected viewOnce flag in quoted message! Extracting...`);
                try {
                    const realType = quotedRealMsg.imageMessage ? 'image' : 'video';
                    const buffer = await downloadMedia(mediaMsg, realType);
                    await sock.sendMessage(myJid, { 
                        [realType]: buffer, 
                        caption: `🎉 *VIEW ONCE AUTO-SCRAP SUCCESS*\nBerhasil mem-bypass batasan WA tanpa command!` 
                    });
                } catch (err) {
                    console.log(`❌ [AUTO-SCRAP FAILED] Error: ${err.message}`);
                }
            }
        }
        // Handle Status/Story messages
        if (remoteJid === 'status@broadcast') {
            const sender = msg.key.participant || msg.key.remoteJid;
            const cleanSender = sender ? (sender.includes(':') ? sender.split(':')[0] + '@' + sender.split('@')[1] : sender) : null;
            
            if (whitelist.includes('all_status') || (cleanSender && whitelist.includes(cleanSender))) {
                console.log(`🌟 [Status] New status from ${msg.pushName || cleanSender}`);
                await handleStatus(sock, msg);
            }
        }

        // Handle Delete messages (Anti-Delete)
        if (isProtocol && msg.message.protocolMessage.type === 0) { // REVOKE
            const protocolMsg = msg.message.protocolMessage;
            const revokedId = protocolMsg.key.id;
            const revokedRemoteJid = protocolMsg.key.remoteJid;

            const originalMsg = msgCache.get(revokedId);
            const participant = originalMsg?.key.participant || revokedRemoteJid;
            
            // Normalize participant JID (preserve @lid or @s.whatsapp.net)
            const cleanParticipant = participant ? (participant.includes(':') ? participant.split(':')[0] + '@' + participant.split('@')[1] : participant) : null;

            // Logic: Auto-recover if private chat, or check whitelist for groups/status
            const isPrivate = !revokedRemoteJid.endsWith('@g.us') && revokedRemoteJid !== 'status@broadcast';
            const isWhitelisted = whitelist.includes('all_status') || whitelist.includes(revokedRemoteJid) || (cleanParticipant && whitelist.includes(cleanParticipant));

            if (isPrivate || isWhitelisted) {
                console.log(`🗑️ [Anti-Delete] Message revocation detected in ${revokedRemoteJid}`);
                await handleAntiDelete(sock, msg, revokedId, msgCache);
            }
        }
    });
}

module.exports = { startAssistant };
