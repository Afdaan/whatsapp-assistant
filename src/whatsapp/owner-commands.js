const { handleAiAccessCommand } = require('../ai/handler');
const { TIMEZONE } = require('../config');
const { downloadMedia } = require('../media');
const { cleanDeviceJid, getRealMessage } = require('./message-utils');

async function handleOwnerCommand({ aiWhitelist, content, contextInfo, isFromMe, msgCache, myJid, remoteJid, sock, whitelist }) {
    if (!isFromMe || !content.startsWith('.')) return false;

    const args = content.split(' ');
    const command = args[0].slice(1).toLowerCase();
    let target = remoteJid;

    if (args[1]) {
        target = args[1].includes('@') ? args[1] : `${args[1].replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    } else if (contextInfo?.participant) {
        target = contextInfo.participant;
    }

    if (await handleAiAccessCommand({ command, target, sock, myJid, whitelist: aiWhitelist })) return true;

    if (command === 'add') {
        if (!target) {
            await sock.sendMessage(myJid, { text: '⚠️ Penggunaan salah. Ketik .add <nomor> atau reply pesan orangnya lalu ketik .add' });
            return true;
        }
        target = cleanDeviceJid(target);
        const message = whitelist.add(target) ? `✅ Added *${target}* to whitelist.` : `ℹ️ *${target}* is already whitelisted.`;
        await sock.sendMessage(myJid, { text: message });
    } else if (command === 'del') {
        whitelist.remove(target);
        await sock.sendMessage(myJid, { text: `❌ Removed *${target}* from whitelist.` });
    } else if (command === 'list' || command === 'whitelist') {
        const displayList = whitelist.entries().filter(id => id !== 'all_status');
        const listText = displayList.length > 0 ? displayList.map(id => `- ${id}`).join('\n') : 'Whitelist is empty.';
        const globalStatus = whitelist.includes('all_status') ? '✅ ON' : '❌ OFF';
        await sock.sendMessage(myJid, { text: `📋 *VIP Whitelist:*\n${listText}\n\n🌐 *Global Status:* ${globalStatus}\n\n_Note: Use .add <JID> | .status on/off_` });
    } else if (command === 'status') {
        const action = args[1]?.toLowerCase();
        if (action === 'on') {
            whitelist.add('all_status');
            await sock.sendMessage(myJid, { text: '✅ *Global Status Monitor is ON.*\nBot akan memantau semua status yang dihapus.' });
        } else if (action === 'off') {
            whitelist.remove('all_status');
            await sock.sendMessage(myJid, { text: '❌ *Global Status Monitor is OFF.*\nBot hanya memantau status dari VIP Whitelist.' });
        } else {
            const status = whitelist.includes('all_status') ? 'ON' : 'OFF';
            await sock.sendMessage(myJid, { text: `ℹ️ Global Status is currently *${status}*.\nKetik *.status on* atau *.status off*` });
        }
    } else if (command === 'groups') {
        const groups = await sock.groupFetchAllParticipating();
        let groupsList = '👥 *Your Groups:*\n\n';
        for (const id in groups) {
            groupsList += `• *${groups[id].subject}*\n  ID: \`${id}\`\n\n`;
        }
        await sock.sendMessage(myJid, { text: groupsList + '_Copy an ID and use .add <ID> to whitelist without typing in the group._' });
    } else if (command === 'stories') {
        const recentStories = new Map();
        for (const [, message] of msgCache.entries()) {
            if (message.key.remoteJid !== 'status@broadcast') continue;
            const sender = message.key.participant || message.key.remoteJid;
            recentStories.set(cleanDeviceJid(sender), { name: message.pushName || 'Unknown', time: message.messageTimestamp });
        }

        if (recentStories.size === 0) {
            await sock.sendMessage(myJid, { text: '📭 Belum ada story yang terekam di memori (sejak bot menyala).' });
        } else {
            let text = '📸 *Recent Stories (Tracked in RAM):*\n\n';
            const sorted = [...recentStories.entries()].sort((a, b) => b[1].time - a[1].time);
            for (const [jid, data] of sorted) {
                const time = new Date(data.time * 1000).toLocaleTimeString('en-US', { timeZone: TIMEZONE });
                text += `👤 *${data.name}*\n  ID: \`${jid}\`\n  Last Post: ${time}\n\n`;
            }
            await sock.sendMessage(myJid, { text: text + '_Copy an ID and use .add <ID> to whitelist._' });
        }
    } else if (command === 'ping') {
        await sock.sendMessage(myJid, { text: '🏓 Pong! Assistant is active.' });
    } else if (command === 'scrap') {
        const quotedMessage = contextInfo?.quotedMessage;
        if (!quotedMessage) {
            await sock.sendMessage(myJid, { text: '⚠️ Reply ke pesan View Once sambil ketik .scrap' });
        } else {
            const quotedRealMsg = getRealMessage(quotedMessage);
            const mediaType = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage'].find(key => quotedRealMsg?.[key]);
            if (!mediaType) {
                await sock.sendMessage(myJid, { text: `❌ *SCRAP FAILED*\n\nTidak ada media dalam pesan balasan. Keys: ${Object.keys(quotedRealMsg || {}).join(', ')}` });
            } else {
                try {
                    const realType = mediaType.replace('Message', '');
                    const buffer = await downloadMedia(quotedRealMsg[mediaType], realType);
                    await sock.sendMessage(myJid, { [realType]: buffer, caption: '🎉 *SCRAP SUCCESS*\nBerhasil mengekstrak media!' });
                } catch (error) {
                    const mediaData = quotedRealMsg[mediaType];
                    await sock.sendMessage(myJid, { text: `❌ *SCRAP FAILED*\n\nMedia ditemukan sebagai ${mediaType}, tapi WA mengunci isinya:\n- Punya URL: ${mediaData.url ? 'Ya' : 'TIDAK'}\n- Punya Kunci (mediaKey): ${mediaData.mediaKey ? 'Ya' : 'TIDAK'}\n\nError: ${error.message}` });
                }
            }
        }
    } else {
        return false;
    }

    return true;
}

module.exports = { handleOwnerCommand };
