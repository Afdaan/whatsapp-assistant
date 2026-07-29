function getRealMessage(message) {
    if (!message) return message;
    if (message.ephemeralMessage?.message) return getRealMessage(message.ephemeralMessage.message);
    if (message.deviceSentMessage?.message) return getRealMessage(message.deviceSentMessage.message);
    if (message.documentWithCaptionMessage?.message) return getRealMessage(message.documentWithCaptionMessage.message);
    if (message.viewOnceMessage?.message) return getRealMessage(message.viewOnceMessage.message);
    if (message.viewOnceMessageV2?.message) return getRealMessage(message.viewOnceMessageV2.message);
    if (message.viewOnceMessageV2Extension?.message) return getRealMessage(message.viewOnceMessageV2Extension.message);
    return message;
}

function checkIsViewOnce(message) {
    if (!message) return false;
    if (message.viewOnceMessage || message.viewOnceMessageV2 || message.viewOnceMessageV2Extension) return true;
    if (message.ephemeralMessage?.message) return checkIsViewOnce(message.ephemeralMessage.message);
    if (message.deviceSentMessage?.message) return checkIsViewOnce(message.deviceSentMessage.message);
    if (message.documentWithCaptionMessage?.message) return checkIsViewOnce(message.documentWithCaptionMessage.message);
    return false;
}

function cleanDeviceJid(jid) {
    return jid?.includes(':') ? `${jid.split(':')[0]}@${jid.split('@')[1]}` : jid;
}

function getContextInfo(message) {
    return message?.extendedTextMessage?.contextInfo || message?.imageMessage?.contextInfo || message?.videoMessage?.contextInfo;
}

function getMedia(message) {
    const realMessage = getRealMessage(message);
    if (!realMessage) return null;
    const mediaKey = ['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage', 'documentMessage']
        .find(key => realMessage[key]);
    return mediaKey ? { type: mediaKey.replace('Message', ''), data: realMessage[mediaKey] } : null;
}

function getMessageContent(message) {
    return message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || message?.videoMessage?.caption || message?.documentMessage?.caption || '';
}

function getMyJid(sock) {
    return cleanDeviceJid(sock.user.id);
}

module.exports = {
    checkIsViewOnce,
    cleanDeviceJid,
    getContextInfo,
    getMedia,
    getMessageContent,
    getMyJid,
    getRealMessage
};
