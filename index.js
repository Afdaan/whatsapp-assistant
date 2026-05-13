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

        // Handle View Once messages
        const messageType = Object.keys(msg.message)[0];
        const isViewOnce = messageType === 'viewOnceMessage' || messageType === 'viewOnceMessageV2';
        const isProtocol = messageType === 'protocolMessage';
        
        const myJid = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
        const isFromMe = msg.key.fromMe;
        const content = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

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

        if (isViewOnce) {
            // View once usually always saved or whitelisted? Let's check whitelist.
            if (whitelist.includes(remoteJid)) {
                console.log(`📸 [View Once] Received in ${remoteJid}`);
                await handleViewOnce(sock, msg);
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
        if (messageType === 'protocolMessage' && msg.message.protocolMessage.type === 0) { // REVOKE
            const protocolMsg = msg.message.protocolMessage;
            const revokedId = protocolMsg.key.id;
            const revokedRemoteJid = protocolMsg.key.remoteJid;

            // Check whitelist (either the chat JID or the participant JID for status)
            const isStatusRevoke = revokedRemoteJid === 'status@broadcast';
            const originalMsg = msgCache.get(revokedId);
            const participant = originalMsg?.key.participant || revokedRemoteJid;

            if (whitelist.includes(revokedRemoteJid) || whitelist.includes(participant)) {
                console.log(`🗑️ [Anti-Delete] Message revocation detected in ${revokedRemoteJid}`);
                await handleAntiDelete(sock, msg, revokedId);
            }
        }
    });
}

async function handleViewOnce(sock, msg) {
    try {
        const type = Object.keys(msg.message)[0];
        const mediaMsg = msg.message[type].message;
        const mediaType = Object.keys(mediaMsg)[0];
        
        const mimetype = mediaMsg[mediaType].mimetype || 'application/octet-stream';
        const buffer = await downloadMedia(mediaMsg[mediaType], mediaType.replace('Message', ''));
        const fileName = `viewonce_${Date.now()}.${getExtension(mimetype)}`;
        const filePath = path.join(DELETED_MEDIA_DIR, fileName);
        
        await fs.writeFile(filePath, buffer);
        console.log(`✅ [View Once] Saved: ${fileName}`);
        
        const myJid = sock.user.id.includes(':') ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : sock.user.id;
        
        // Forward back to your own JID or log it
        await sock.sendMessage(myJid, { 
            [mediaType.replace('Message', '')]: buffer, 
            caption: `View Once Intercepted from ${msg.key.remoteJid}` 
        });
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
        let header = `⚠️ *MESSAGE DELETED* ⚠️\n`;
        header += `👤 *Sender:* ${senderName} (${senderNumber})\n`;
        if (isGroup) {
            header += `📍 *Group:* ${groupJid}\n`;
        }
        header += `🕒 *Time:* ${new Date(originalMsg.messageTimestamp * 1000).toLocaleString()}\n\n`;
        
        let content = { text: header };
        
        const type = Object.keys(originalMsg.message)[0];
        if (type === 'conversation' || type === 'extendedTextMessage') {
            const text = originalMsg.message.conversation || originalMsg.message.extendedTextMessage.text;
            content.text += `Content: ${text}`;
            await sock.sendMessage(myJid, content);
        } else if (originalMsg.message.imageMessage || originalMsg.message.videoMessage) {
            const mediaType = originalMsg.message.imageMessage ? 'image' : 'video';
            const buffer = await downloadMedia(originalMsg.message[mediaType + 'Message'], mediaType);
            
            await sock.sendMessage(myJid, {
                [mediaType]: buffer,
                caption: content.text + (originalMsg.message[mediaType + 'Message'].caption || '')
            });
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
