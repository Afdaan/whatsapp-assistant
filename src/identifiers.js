function normalizeUserJid(value) {
    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (!trimmed) return null;

    if (!trimmed.includes('@')) {
        const number = trimmed.replace(/\D/g, '');
        return number ? `${number}@s.whatsapp.net` : null;
    }

    const [rawUser, server] = trimmed.split('@');
    if (!rawUser || !['s.whatsapp.net', 'lid'].includes(server)) return null;

    const user = rawUser.split(':')[0].replace(/\D/g, '');
    return user ? `${user}@${server}` : null;
}

module.exports = { normalizeUserJid };
