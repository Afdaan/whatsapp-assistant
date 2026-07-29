const { getContentType } = require('@whiskeysockets/baileys');
const fs = require('fs-extra');
const path = require('node:path');
const { DELETED_MEDIA_DIR, TIMEZONE } = require('../config');
const { downloadMedia, getExtension } = require('../media');
const { getMedia, getMyJid, getRealMessage } = require('./message-utils');

async function handleViewOnce(sock, msg) {
    try {
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
        const myJid = getMyJid(sock);

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
        header += `🕒 *Time:* ${new Date(msg.messageTimestamp * 1000).toLocaleString('en-US', { timeZone: TIMEZONE })}\n\n`;

        await sock.sendMessage(myJid, { 
            [realType]: buffer, 
            caption: header + (mediaMsg[mediaType].caption || '')
        });
        
        // Delete the file from local storage after forwarding
        fs.unlink(filePath).catch(err => console.error('Failed to delete temp viewonce file:', err));

        console.log(`✅ [View Once] Recovered from ${senderName} (${senderNumber})`);
    } catch (e) {
        console.error('Failed to handle view once:', e);
    }
}

async function handleStatus(sock, msg) {
    try {
        const sender = msg.key.participant || msg.key.remoteJid;
        const senderNumber = sender.split('@')[0];
        const senderName = msg.pushName || 'Unknown';
        const myJid = getMyJid(sock);

        const realMsg = getRealMessage(msg.message);

        const media = getMedia(realMsg);
        const type = getContentType(realMsg) || Object.keys(realMsg || {})[0];

        let header = `🌟 *NEW STATUS RECEIVED* 🌟\n`;
        header += `👤 *Sender:* ${senderName} (${senderNumber})\n`;
        header += `🕒 *Time:* ${new Date(msg.messageTimestamp * 1000).toLocaleString('en-US', { timeZone: TIMEZONE })}\n\n`;

        if (media) {
            console.log(`📥 [Status] Downloading ${media.type} from ${senderName}...`);
            const buffer = await downloadMedia(media.data, media.type);
            
            // Save temporary file (just in case)
            const fileName = `status_${Date.now()}.${getExtension(media.data.mimetype || 'application/octet-stream')}`;
            const filePath = path.join(DELETED_MEDIA_DIR, fileName);
            await fs.writeFile(filePath, buffer);

            const hasCaption = ['image', 'video', 'document'].includes(media.type);
            const captionText = media.data.caption ? `📝 *Caption:* ${media.data.caption}` : '';
            
            const payload = {
                [media.type]: buffer,
                mimetype: media.data.mimetype,
                fileName: media.data.fileName
            };

            if (hasCaption) {
                payload.caption = header + captionText;
                await sock.sendMessage(myJid, payload);
            } else {
                // For media without caption support (audio, sticker), send header first then media
                const sent = await sock.sendMessage(myJid, { text: header + captionText });
                await sock.sendMessage(myJid, payload, { quoted: sent });
            }
            
            // Cleanup
            fs.unlink(filePath).catch(err => console.error('Failed to delete temp status file:', err));
        } else if (type === 'conversation' || type === 'extendedTextMessage') {
            const text = realMsg.conversation || realMsg.extendedTextMessage?.text || '';
            if (text) {
                await sock.sendMessage(myJid, { text: header + `💬 *Content:* ${text}` });
            }
        }
        
        console.log(`✅ [Status] Forwarded status from ${senderName} (${senderNumber})`);
    } catch (e) {
        console.error('Failed to handle status update:', e);
    }
}



async function handleAntiDelete(sock, revokeMsg, revokedId, msgCache) {
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

    const myJid = getMyJid(sock);

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
        
        const deleteTime = Math.floor(Date.now() / 1000);
        const diffSeconds = Math.max(0, deleteTime - originalMsg.messageTimestamp);
        const isExpired = isStatus && diffSeconds >= 86300; // ~24 hours

        let header = isStatus ? (isExpired ? `⌛ *STORY EXPIRED* ⌛\n` : `🌟 *STORY DELETED* 🌟\n`) : `⚠️ *MESSAGE DELETED* ⚠️\n`;
        
        header += `👤 *Sender:* ${senderName} ${!senderNumber.includes('@') ? `(${senderNumber})` : ''}\n`;
        
        if (isGroup && !isStatus) {
            header += `📍 *Group:* ${groupName}\n`;
        }
        
        const postDate = new Date(originalMsg.messageTimestamp * 1000);
        header += `🕒 *Time:* ${postDate.toLocaleString('en-US', { timeZone: TIMEZONE })}\n`;
        
        if (isStatus) {
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
        
        const media = getMedia(originalMsg.message);
        const type = getContentType(originalMsg.message) || Object.keys(originalMsg.message)[0];

        if (media) {
            try {
                const buffer = await downloadMedia(media.data, media.type);
                
                // Save to disk
                const prefix = isStatus ? (isExpired ? 'expired' : 'deleted_story') : 'deleted_msg';
                const fileName = `${prefix}_${Date.now()}.${getExtension(media.data.mimetype || 'application/octet-stream')}`;
                const filePath = path.join(DELETED_MEDIA_DIR, fileName);
                await fs.writeFile(filePath, buffer);

                const hasCaption = ['image', 'video', 'document'].includes(media.type);

                if (hasCaption) {
                    await sock.sendMessage(myJid, {
                        [media.type]: buffer,
                        caption: header + (media.data.caption || ''),
                        mimetype: media.data.mimetype,
                        fileName: media.data.fileName
                    });
                } else {
                    // Send header as text first for media types that don't support caption (e.g. sticker, audio)
                    const sentMsg = await sock.sendMessage(myJid, { text: header });
                    
                    const mediaPayload = {
                        [media.type]: buffer,
                        mimetype: media.data.mimetype
                    };
                    
                    if (media.type === 'audio' && media.data.ptt) {
                        mediaPayload.ptt = true;
                    }

                    await sock.sendMessage(myJid, mediaPayload, { quoted: sentMsg });
                }
                
                // Delete the file from local storage after forwarding
                fs.unlink(filePath).catch(err => console.error('Failed to delete temp media file:', err));
                
            } catch (err) {
                console.error(`[Anti-Delete] Failed to download media for message ${revokedId}:`, err.message);
                content.text += `\n❌ *(Media gagal didownload: file mungkin sudah dihapus permanen dari server WA atau terjadi error koneksi)*`;
                await sock.sendMessage(myJid, content);
            }
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

module.exports = { handleAntiDelete, handleStatus, handleViewOnce };
