const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidDecode,
    downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs-extra');
const path = require('path');
const qrcode = require('qrcode-terminal');
const mime = require('mime-types');

const logger = pino({ level: 'silent' });

const DELETED_MEDIA_DIR = path.join(__dirname, 'deleted_media');
fs.ensureDirSync(DELETED_MEDIA_DIR);

const WHITELIST_PATH = path.join(__dirname, 'whitelist.json');
let whitelist = [];
if (fs.existsSync(WHITELIST_PATH) && fs.lstatSync(WHITELIST_PATH).isFile()) {
    whitelist = fs.readJsonSync(WHITELIST_PATH);
}

function saveWhitelist() {
    fs.writeJsonSync(WHITELIST_PATH, whitelist);
}

// Simple message cache to handle anti-delete
const MSG_CACHE_PATH = path.join(__dirname, 'msg_cache.json');
let msgCache = new Map();
const MAX_CACHE_SIZE = 2000;

if (fs.existsSync(MSG_CACHE_PATH) && fs.lstatSync(MSG_CACHE_PATH).isFile()) {
    try {
        const data = fs.readJsonSync(MSG_CACHE_PATH);
        msgCache = new Map(Object.entries(data));
    } catch (e) {
        console.error('Failed to load message cache:', e);
    }
}

function saveMsgCache() {
    try {
        const data = Object.fromEntries(msgCache);
        fs.writeJsonSync(MSG_CACHE_PATH, data);
    } catch (e) {
        console.error('Failed to save message cache:', e);
    }
}

// Auto-save cache every 10 seconds
setInterval(saveMsgCache, 10000);

// Heartbeat Monitor (Status log every 60 seconds)
setInterval(() => {
    console.log(`💓 [Heartbeat] Assistant is active. Cache size: ${msgCache.size}/${MAX_CACHE_SIZE} messages.`);
}, 60000);

async function startAssistant() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
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

        // --- Message Unwrapping Logic ---
        // Some messages are wrapped in ephemeralMessage, viewOnceMessage, or deviceSentMessage
        const getRealMessage = (m) => {
            if (!m) return m;
            if (m.ephemeralMessage?.message) return getRealMessage(m.ephemeralMessage.message);
            if (m.deviceSentMessage?.message) return getRealMessage(m.deviceSentMessage.message);
            if (m.documentWithCaptionMessage?.message) return getRealMessage(m.documentWithCaptionMessage.message);
            if (m.viewOnceMessage?.message) return getRealMessage(m.viewOnceMessage.message);
            if (m.viewOnceMessageV2?.message) return getRealMessage(m.viewOnceMessageV2.message);
            if (m.viewOnceMessageV2Extension?.message) return getRealMessage(m.viewOnceMessageV2Extension.message);
            return m;
        };

        const checkIsViewOnce = (m) => {
            if (!m) return false;
            if (m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension) return true;
            if (m.ephemeralMessage?.message) return checkIsViewOnce(m.ephemeralMessage.message);
            if (m.deviceSentMessage?.message) return checkIsViewOnce(m.deviceSentMessage.message);
            if (m.documentWithCaptionMessage?.message) return checkIsViewOnce(m.documentWithCaptionMessage.message);
            return false;
        };

        const realMsg = getRealMessage(msg.message);
        
        // --- DEBUG LOG ---
        const contentStr = realMsg?.conversation || realMsg?.extendedTextMessage?.text || '';
        if (contentStr.includes('view once') || msg.message.viewOnceMessage || msg.message.viewOnceMessageV2) {
            console.log(`\n🔍 [DEBUG] SUSPECTED VIEW ONCE FROM ${msg.key.remoteJid}`);
            console.log(`🔍 [DEBUG] Raw keys:`, Object.keys(msg.message));
            if (msg.message.extendedTextMessage) {
                console.log(`🔍 [DEBUG] extendedTextMessage text:`, msg.message.extendedTextMessage.text);
            }
        }

        const isViewOnce = checkIsViewOnce(msg.message);
        const isProtocol = !!msg.message.protocolMessage;
        
        const myJid = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
        const isFromMe = msg.key.fromMe;
        
        // Extract text content from the unwrapped message
        const content = realMsg?.conversation || realMsg?.extendedTextMessage?.text || '';

        // Only cache actual content, not protocol messages
        if (!isProtocol) {
            msgCache.set(msgId, JSON.parse(JSON.stringify(msg)));
            // Maintain cache limit
            if (msgCache.size > MAX_CACHE_SIZE) {
                const firstKey = msgCache.keys().next().value;
                msgCache.delete(firstKey);
            }
        }

        // --- Whitelist Management Commands (Only from Me) ---
        if (isFromMe && content.startsWith('.')) {
            const args = content.split(' ');
            const cmd = args[0].slice(1).toLowerCase();
            let target = remoteJid;
            
            if (args[1]) {
                if (args[1].includes('@')) {
                    target = args[1]; // Already a JID
                } else {
                    target = args[1].replace(/[^0-9]/g, '') + '@s.whatsapp.net'; // Number to JID
                }
            }

            if (cmd === 'add') {
                if (!whitelist.includes(target)) {
                    whitelist.push(target);
                    saveWhitelist();
                    await sock.sendMessage(myJid, { text: `✅ Added *${target}* to whitelist.` });
                } else {
                    await sock.sendMessage(myJid, { text: `ℹ️ *${target}* is already whitelisted.` });
                }
            } else if (cmd === 'del') {
                whitelist = whitelist.filter(id => id !== target);
                saveWhitelist();
                await sock.sendMessage(myJid, { text: `❌ Removed *${target}* from whitelist.` });
            } else if (cmd === 'list' || cmd === 'whitelist') {
                const listText = whitelist.length > 0 ? whitelist.map(id => `- ${id}`).join('\n') : 'Whitelist is empty.';
                await sock.sendMessage(myJid, { text: `📋 *Whitelist:*\n${listText}\n\n_Note: Use .add <JID> or .add <number>_` });
            } else if (cmd === 'groups') {
                const groups = await sock.groupFetchAllParticipating();
                let groupsList = '👥 *Your Groups:*\n\n';
                for (const id in groups) {
                    groupsList += `• *${groups[id].subject}*\n  ID: \`${id}\`\n\n`;
                }
                await sock.sendMessage(myJid, { text: groupsList + '_Copy an ID and use .add <ID> to whitelist without typing in the group._' });
            } else if (cmd === 'ping') {
                await sock.sendMessage(myJid, { text: '🏓 Pong! Assistant is active.' });
            }
        }

        // --- Reply to View Once Experiment ---
        const contextInfo = realMsg?.extendedTextMessage?.contextInfo || realMsg?.imageMessage?.contextInfo || realMsg?.videoMessage?.contextInfo;
        const quotedMessage = contextInfo?.quotedMessage;
        
        if (quotedMessage && checkIsViewOnce(quotedMessage)) {
            console.log(`\n🧪 [EXPERIMENT] You replied to a View Once message! Let's try to extract it...`);
            console.log(`🧪 [EXPERIMENT] Quoted Message Keys:`, Object.keys(quotedMessage));
            
            try {
                const quotedRealMsg = getRealMessage(quotedMessage);
                const validMediaKeys = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'];
                const mediaType = Object.keys(quotedRealMsg || {}).find(key => validMediaKeys.includes(key));
                
                if (!mediaType) {
                    console.log(`❌ [EXPERIMENT FAILED] No media keys found in the quoted message. WhatsApp stripped them.`);
                    await sock.sendMessage(myJid, { text: `❌ *EXPERIMENT FAILED*\n\nI tried to extract the View Once media you replied to, tapi WhatsApp juga menghapus file-nya di data balasan (quoted). Data yang tersisa cuma: ${Object.keys(quotedRealMsg || {}).join(', ')}` });
                } else {
                    console.log(`✅ [EXPERIMENT SUCCESS?] Found media type: ${mediaType}. Trying to download...`);
                    const realType = mediaType.replace('Message', '');
                    const buffer = await downloadMedia(quotedRealMsg[mediaType], realType);
                    
                    await sock.sendMessage(myJid, { 
                        [realType]: buffer, 
                        caption: `🎉 *EXPERIMENT SUCCESS*\nTernyata trik reply berhasil menembus batasan WA!` 
                    });
                }
            } catch (err) {
                console.log(`❌ [EXPERIMENT FAILED] Error during download: ${err.message}`);
                await sock.sendMessage(myJid, { text: `❌ *EXPERIMENT FAILED*\n\nData fotonya ada, tapi gagal didownload karena kuncinya (mediaKey) kosong/dihapus WA: ${err.message}` });
            }
        }

        // --- View Once Handling ---
        // WhatsApp blocks View Once media from reaching linked devices (WA Web/Bots).
        // It sends a placeholder text instead. We intercept that to notify you.
        const isViewOncePlaceholder = content.toLowerCase().includes('view once message') && content.toLowerCase().includes('added privacy');
        
        if (isViewOnce || isViewOncePlaceholder) {
            const isPrivate = !remoteJid.endsWith('@g.us') && remoteJid !== 'status@broadcast';
            
            if (isPrivate || whitelist.includes(remoteJid)) {
                if (isViewOncePlaceholder) {
                    console.log(`🔒 [View Once Blocked] Placeholder received from ${remoteJid}`);
                    const senderJid = msg.key.participant || remoteJid;
                    const senderName = msg.pushName || senderJid.split('@')[0];
                    await sock.sendMessage(myJid, {
                        text: `🔒 *VIEW ONCE BLOCKED BY WHATSAPP*\n👤 *From:* ${senderName}\n📍 *Chat:* ${remoteJid}\n\n_WhatsApp no longer sends "View Once" media to WhatsApp Web or bots. The media was only sent to your physical phone. Please open WhatsApp on your phone to view it!_`
                    });
                } else {
                    console.log(`📸 [View Once] Received real payload in ${remoteJid}`);
                    await handleViewOnce(sock, msg);
                }
            }
        }

        // Handle Status/Story messages
        if (remoteJid === 'status@broadcast') {
            const sender = msg.key.participant || msg.key.remoteJid;
            if (whitelist.includes(sender)) {
                console.log(`🌟 [Status] New status from ${msg.pushName || sender}`);
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

            // Logic: Auto-recover if private chat, or check whitelist for groups/status
            const isPrivate = !revokedRemoteJid.endsWith('@g.us') && revokedRemoteJid !== 'status@broadcast';
            const isWhitelisted = whitelist.includes(revokedRemoteJid) || whitelist.includes(participant);

            if (isPrivate || isWhitelisted) {
                console.log(`🗑️ [Anti-Delete] Message revocation detected in ${revokedRemoteJid}`);
                await handleAntiDelete(sock, msg, revokedId);
            }
        }
    });
}

async function handleViewOnce(sock, msg) {
    try {
        const getRealMessage = (m) => {
            if (!m) return m;
            if (m.ephemeralMessage?.message) return getRealMessage(m.ephemeralMessage.message);
            if (m.deviceSentMessage?.message) return getRealMessage(m.deviceSentMessage.message);
            if (m.documentWithCaptionMessage?.message) return getRealMessage(m.documentWithCaptionMessage.message);
            if (m.viewOnceMessage?.message) return getRealMessage(m.viewOnceMessage.message);
            if (m.viewOnceMessageV2?.message) return getRealMessage(m.viewOnceMessageV2.message);
            if (m.viewOnceMessageV2Extension?.message) return getRealMessage(m.viewOnceMessageV2Extension.message);
            return m;
        };

        const mediaMsg = getRealMessage(msg.message);
        if (!mediaMsg) return;

        // Find the actual media key, ignoring metadata like messageContextInfo
        const validMediaKeys = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'];
        const mediaType = Object.keys(mediaMsg).find(key => validMediaKeys.includes(key));
        
        if (!mediaType) {
            console.log("❌ [View Once] Media type not found in message:", Object.keys(mediaMsg));
            return;
        }
        
        const realType = mediaType.replace('Message', '');
        const mimetype = mediaMsg[mediaType].mimetype || 'application/octet-stream';
        const buffer = await downloadMedia(mediaMsg[mediaType], realType);
        
        const fileName = `viewonce_${Date.now()}.${getExtension(mimetype)}`;
        const filePath = path.join(DELETED_MEDIA_DIR, fileName);
        await fs.writeFile(filePath, buffer);
        
        const remoteJid = msg.key.remoteJid;
        const senderJid = msg.key.participant || msg.key.remoteJid;
        const senderNumber = senderJid.split('@')[0];
        const senderName = msg.pushName || 'Unknown';
        const isGroup = remoteJid.endsWith('@g.us');
        const myJid = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;

        let groupName = remoteJid;
        if (isGroup) {
            try {
                const metadata = await sock.groupMetadata(remoteJid);
                groupName = metadata.subject || remoteJid;
            } catch (e) {}
        }

        let header = `📸 *VIEW ONCE INTERCEPTED* 📸\n`;
        header += `👤 *Sender:* ${senderName} (${senderNumber})\n`;
        if (isGroup) {
            header += `📍 *Group:* ${groupName}\n`;
        }
        header += `🕒 *Time:* ${new Date(msg.messageTimestamp * 1000).toLocaleString()}\n\n`;

        await sock.sendMessage(myJid, { 
            [realType]: buffer, 
            caption: header + (mediaMsg[mediaType].caption || '')
        });
        
        console.log(`✅ [View Once] Recovered from ${senderName} (${senderNumber})`);
    } catch (e) {
        console.error('Failed to handle view once:', e);
    }
}

async function handleStatus(sock, msg) {
    try {
        const messageType = Object.keys(msg.message)[0];
        if (messageType === 'protocolMessage') return;

        let buffer;
        let type = 'text';

        let mimetype = 'text/plain';

        if (msg.message.imageMessage) {
            mimetype = msg.message.imageMessage.mimetype;
            buffer = await downloadMedia(msg.message.imageMessage, 'image');
            type = 'image';
        } else if (msg.message.videoMessage) {
            mimetype = msg.message.videoMessage.mimetype;
            buffer = await downloadMedia(msg.message.videoMessage, 'video');
            type = 'video';
        }

        const ext = getExtension(mimetype);

        const sender = msg.key.participant || msg.key.remoteJid;
        const fileName = `status_${sender.split('@')[0]}_${Date.now()}.${ext}`;
        const filePath = path.join(DELETED_MEDIA_DIR, fileName);

        if (buffer) {
            await fs.writeFile(filePath, buffer);
            console.log(`✅ [Status] Saved ${type} from ${sender.split('@')[0]}`);
        }
    } catch (e) {
        console.error('Failed to handle status:', e);
    }
}

async function handleAntiDelete(sock, revokeMsg, revokedId) {
    const originalMsg = msgCache.get(revokedId);
    if (!originalMsg) {
        console.log(`[Anti-Delete] Original message ${revokedId} not found in cache.`);
        return;
    }

    const senderJid = originalMsg.key.participant || originalMsg.key.remoteJid;
    const senderNumber = senderJid.split('@')[0];
    const senderName = originalMsg.pushName || 'Unknown';
    const isGroup = originalMsg.key.remoteJid.endsWith('@g.us');
    const groupJid = isGroup ? originalMsg.key.remoteJid : null;
    
    console.log(`[Anti-Delete] Recovered message from ${senderName} (${senderNumber})`);

    const myJid = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;

    try {
        // Notify yourself about the deleted message
        let groupName = groupJid;
        if (isGroup) {
            try {
                const metadata = await sock.groupMetadata(groupJid);
                groupName = metadata.subject || groupJid;
            } catch (err) {
                console.error('Failed to fetch group metadata:', err);
            }
        }

        let header = `⚠️ *MESSAGE DELETED* ⚠️\n`;
        header += `👤 *Sender:* ${senderName} (${senderNumber})\n`;
        if (isGroup) {
            header += `📍 *Group:* ${groupName}\n`;
        }
        header += `🕒 *Time:* ${new Date(originalMsg.messageTimestamp * 1000).toLocaleString()}\n\n`;
        
        let content = { text: header };
        
        // Helper to extract media from View Once or normal messages
        const getMedia = (m) => {
            if (m.imageMessage) return { type: 'image', data: m.imageMessage };
            if (m.videoMessage) return { type: 'video', data: m.videoMessage };
            if (m.viewOnceMessage?.message) return getMedia(m.viewOnceMessage.message);
            if (m.viewOnceMessageV2?.message) return getMedia(m.viewOnceMessageV2.message);
            return null;
        };

        const media = getMedia(originalMsg.message);
        const type = Object.keys(originalMsg.message)[0];

        if (media) {
            const buffer = await downloadMedia(media.data, media.type);
            await sock.sendMessage(myJid, {
                [media.type]: buffer,
                caption: header + (media.data.caption || '')
            });
        } else if (type === 'conversation' || type === 'extendedTextMessage') {
            const text = originalMsg.message.conversation || originalMsg.message.extendedTextMessage?.text;
            content.text += `*Content:* ${text}`;
            await sock.sendMessage(myJid, content);
        } else {
            content.text += `(Type: ${type})`;
            await sock.sendMessage(myJid, content);
        }
    } catch (e) {
        console.error('Failed to handle anti-delete:', e);
    }
}

async function downloadMedia(message, type) {
    const stream = await downloadContentFromMessage(message, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
    }
    return buffer;
}

function getExtension(mimetype) {
    return mime.extension(mimetype) || 'bin';
}

startAssistant();
