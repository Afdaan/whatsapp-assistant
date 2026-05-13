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
        


        const isViewOnce = checkIsViewOnce(msg.message);
        const isProtocol = !!msg.message.protocolMessage;
        
        const myJid = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
        const isFromMe = msg.key.fromMe;
        
        // Extract text content from the unwrapped message
        const content = realMsg?.conversation || realMsg?.extendedTextMessage?.text || '';
        const contextInfo = realMsg?.extendedTextMessage?.contextInfo || realMsg?.imageMessage?.contextInfo || realMsg?.videoMessage?.contextInfo;

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
                    target = args[1]; // Already a JID or LID
                } else {
                    target = args[1].replace(/[^0-9]/g, '') + '@s.whatsapp.net'; // Number to JID
                }
            } else if (contextInfo?.participant) {
                // If replying to a message (e.g. replying to a status), extract the hidden LID/JID
                target = contextInfo.participant;
            } else {
                const quotedRealMsg = getRealMessage(contextInfo?.quotedMessage);
                if (quotedRealMsg) target = remoteJid; // Fallback if replying in private chat
            }

            if (cmd === 'add') {
                if (!target) {
                    await sock.sendMessage(myJid, { text: `⚠️ Penggunaan salah. Ketik .add <nomor> atau reply pesan orangnya lalu ketik .add` });
                    return;
                }
                
                // Clean the multi-device suffix just in case
                target = target.includes(':') ? target.split(':')[0] + '@' + target.split('@')[1] : target;

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
                const displayList = whitelist.filter(id => id !== 'all_status');
                const listText = displayList.length > 0 ? displayList.map(id => `- ${id}`).join('\n') : 'Whitelist is empty.';
                const globalStatus = whitelist.includes('all_status') ? '✅ ON' : '❌ OFF';
                
                await sock.sendMessage(myJid, { text: `📋 *VIP Whitelist:*\n${listText}\n\n🌐 *Global Status:* ${globalStatus}\n\n_Note: Use .add <JID> | .status on/off_` });
            } else if (cmd === 'status') {
                const action = args[1]?.toLowerCase();
                if (action === 'on') {
                    if (!whitelist.includes('all_status')) {
                        whitelist.push('all_status');
                        saveWhitelist();
                    }
                    await sock.sendMessage(myJid, { text: `✅ *Global Status Monitor is ON.*\nBot akan memantau semua status yang dihapus.` });
                } else if (action === 'off') {
                    whitelist = whitelist.filter(id => id !== 'all_status');
                    saveWhitelist();
                    await sock.sendMessage(myJid, { text: `❌ *Global Status Monitor is OFF.*\nBot hanya memantau status dari VIP Whitelist.` });
                } else {
                    const status = whitelist.includes('all_status') ? 'ON' : 'OFF';
                    await sock.sendMessage(myJid, { text: `ℹ️ Global Status is currently *${status}*.\nKetik *.status on* atau *.status off*` });
                }
            } else if (cmd === 'groups') {
                const groups = await sock.groupFetchAllParticipating();
                let groupsList = '👥 *Your Groups:*\n\n';
                for (const id in groups) {
                    groupsList += `• *${groups[id].subject}*\n  ID: \`${id}\`\n\n`;
                }
                await sock.sendMessage(myJid, { text: groupsList + '_Copy an ID and use .add <ID> to whitelist without typing in the group._' });
            } else if (cmd === 'stories') {
                const recentStories = new Map();
                
                for (const [id, m] of msgCache.entries()) {
                    if (m.key.remoteJid === 'status@broadcast') {
                        const sender = m.key.participant || m.key.remoteJid;
                        const cleanSender = sender.includes(':') ? sender.split(':')[0] + '@' + sender.split('@')[1] : sender;
                        const name = m.pushName || 'Unknown';
                        
                        recentStories.set(cleanSender, { name, time: m.messageTimestamp });
                    }
                }
                
                if (recentStories.size === 0) {
                    await sock.sendMessage(myJid, { text: '📭 Belum ada story yang terekam di memori (sejak bot menyala).' });
                } else {
                    let text = '📸 *Recent Stories (Tracked in RAM):*\n\n';
                    const sorted = [...recentStories.entries()].sort((a, b) => b[1].time - a[1].time);
                    
                    for (const [jid, data] of sorted) {
                        const timeStr = new Date(data.time * 1000).toLocaleTimeString();
                        text += `👤 *${data.name}*\n  ID: \`${jid}\`\n  Last Post: ${timeStr}\n\n`;
                    }
                    text += '_Copy an ID and use .add <ID> to whitelist._';
                    await sock.sendMessage(myJid, { text });
                }
            } else if (cmd === 'ping') {
                await sock.sendMessage(myJid, { text: '🏓 Pong! Assistant is active.' });
            } else if (cmd === 'scrap') {
                // Manual scraping attempt for quoted messages
                const quotedMessage = contextInfo?.quotedMessage;
                
                if (!quotedMessage) {
                    await sock.sendMessage(myJid, { text: `⚠️ Reply ke pesan View Once sambil ketik .scrap` });
                } else {
                    console.log(`\n🧪 [SCRAP] Attempting manual scrap...`);
                    const quotedRealMsg = getRealMessage(quotedMessage);
                    const validMediaKeys = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'];
                    const mediaType = Object.keys(quotedRealMsg || {}).find(key => validMediaKeys.includes(key));
                    
                    if (!mediaType) {
                        await sock.sendMessage(myJid, { text: `❌ *SCRAP FAILED*\n\nTidak ada media dalam pesan balasan. Keys: ${Object.keys(quotedRealMsg || {}).join(', ')}` });
                    } else {
                        try {
                            const realType = mediaType.replace('Message', '');
                            const buffer = await downloadMedia(quotedRealMsg[mediaType], realType);
                            await sock.sendMessage(myJid, { 
                                [realType]: buffer, 
                                caption: `🎉 *SCRAP SUCCESS*\nBerhasil mengekstrak media!` 
                            });
                        } catch (err) {
                            console.log(`❌ [SCRAP FAILED] Error: ${err.message}`);
                            const mediaData = quotedRealMsg[mediaType];
                            const hasUrl = !!mediaData.url;
                            const hasMediaKey = !!mediaData.mediaKey;
                            await sock.sendMessage(myJid, { text: `❌ *SCRAP FAILED*\n\nMedia ditemukan sebagai ${mediaType}, tapi WA mengunci isinya:\n- Punya URL: ${hasUrl ? 'Ya' : 'TIDAK'}\n- Punya Kunci (mediaKey): ${hasMediaKey ? 'Ya' : 'TIDAK'}\n\nError: ${err.message}` });
                        }
                    }
                }
            }
        }

        const stanzaId = contextInfo?.stanzaId;
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
                console.log(`🌟 [Status] New status from ${msg.pushName || cleanSender} (Tracked in RAM)`);
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

        const isStatus = originalMsg.key.remoteJid === 'status@broadcast';
        let header = isStatus ? `🌟 *STORY DELETED* 🌟\n` : `⚠️ *MESSAGE DELETED* ⚠️\n`;
        
        header += `👤 *Sender:* ${senderName} ${!senderNumber.includes('@') ? `(${senderNumber})` : ''}\n`;
        
        if (isGroup && !isStatus) {
            header += `📍 *Group:* ${groupName}\n`;
        }
        
        const postDate = new Date(originalMsg.messageTimestamp * 1000);
        header += `🕒 *Time:* ${postDate.toLocaleString()}\n`;
        
        if (isStatus) {
            const deleteTime = Math.floor(Date.now() / 1000);
            const diffSeconds = Math.max(0, deleteTime - originalMsg.messageTimestamp);
            const diffMins = Math.floor(diffSeconds / 60);
            const diffHrs = Math.floor(diffMins / 60);
            
            let duration = '';
            if (diffHrs > 0) duration += `${diffHrs}h `;
            if (diffMins % 60 > 0) duration += `${diffMins % 60}m `;
            if (diffHrs === 0 && diffMins === 0) duration = `${diffSeconds}s`;
            else if (diffHrs === 0) duration += `${diffSeconds % 60}s`;
            
            header += `⏱️ *Deleted After:* ${duration.trim()}\n`;
        }
        
        header += `\n`;
        
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
