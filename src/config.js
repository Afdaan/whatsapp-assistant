const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

function parseIntegerEnv(name, fallback, min, max) {
    const value = Number.parseInt(process.env[name], 10);
    return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const AI_CONFIG = {
    baseUrl: (process.env.AI_BASE_URL || '').trim().replace(/\/+$/, ''),
    apiKey: (process.env.AI_API_KEY || '').trim(),
    model: (process.env.AI_MODEL || '').trim(),
    imageModel: (process.env.AI_IMAGE_MODEL || '').trim(),
    ttsModel: (process.env.AI_TTS_MODEL || '').trim(),
    sttModel: (process.env.AI_STT_MODEL || '').trim(),
    videoModel: (process.env.AI_VIDEO_MODEL || '').trim(),
    systemPromptPath: path.resolve(ROOT_DIR, process.env.AI_SYSTEM_PROMPT_FILE || 'prompts/system.txt'),
    timeoutMs: parseIntegerEnv('AI_TIMEOUT_MS', 60000, 1000, 120000),
    videoTimeoutMs: parseIntegerEnv('AI_VIDEO_TIMEOUT_MS', 600000, 30000, 1800000),
    videoPollMs: parseIntegerEnv('AI_VIDEO_POLL_MS', 5000, 1000, 30000),
    maxTokens: parseIntegerEnv('AI_MAX_TOKENS', 1000, 1, 4000),
    maxPromptChars: parseIntegerEnv('AI_MAX_PROMPT_CHARS', 4000, 1, 12000),
    historyMaxMessages: parseIntegerEnv('AI_HISTORY_MAX_MESSAGES', 8, 2, 40),
    rateLimitWindowMs: parseIntegerEnv('AI_RATE_LIMIT_WINDOW_MS', 60000, 10000, 3600000),
    rateLimitMaxRequests: parseIntegerEnv('AI_RATE_LIMIT_MAX_REQUESTS', 5, 1, 100),
    rateLimitGlobalMaxRequests: parseIntegerEnv('AI_RATE_LIMIT_GLOBAL_MAX_REQUESTS', 20, 1, 1000),
    mediaMaxBytes: parseIntegerEnv('AI_MEDIA_MAX_BYTES', 20 * 1024 * 1024, 1024, 100 * 1024 * 1024),
    allowGroups: process.env.AI_ALLOW_GROUPS === 'true'
};

module.exports = {
    AI_CONFIG,
    AI_HISTORY_PATH: path.join(ROOT_DIR, 'ai_history.json'),
    AI_STATE_PATH: path.join(ROOT_DIR, 'ai_state.json'),
    AI_WHITELIST_PATH: path.join(ROOT_DIR, 'ai_whitelist.json'),
    AUTH_DIR: path.join(ROOT_DIR, 'auth_info'),
    DELETED_MEDIA_DIR: path.join(ROOT_DIR, 'deleted_media'),
    MAX_CACHE_SIZE: 10000,
    MSG_CACHE_PATH: path.join(ROOT_DIR, 'msg_cache.json'),
    ROOT_DIR,
    TIMEZONE: process.env.TZ || 'Asia/Jakarta',
    WHATSAPP_SEND_INTERVAL_MS: parseIntegerEnv('WHATSAPP_SEND_INTERVAL_MS', 1500, 0, 10000),
    WHITELIST_PATH: path.join(ROOT_DIR, 'whitelist.json')
};
