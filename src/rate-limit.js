function prune(timestamps, now, windowMs) {
    while (timestamps.length && timestamps[0] <= now - windowMs) timestamps.shift();
}

function retryAfter(timestamps, now, windowMs) {
    return Math.max(1000, timestamps[0] + windowMs - now);
}

function createRequestRateLimiter({ windowMs, maxPerKey, maxGlobal }) {
    const requestsByKey = new Map();
    const globalRequests = [];
    const keyNotices = new Map();
    let globalNoticeUntil = 0;

    return {
        check(key, now = Date.now()) {
            prune(globalRequests, now, windowMs);
            if (globalRequests.length >= maxGlobal) {
                const retryAfterMs = retryAfter(globalRequests, now, windowMs);
                const notify = now >= globalNoticeUntil;
                if (notify) globalNoticeUntil = now + retryAfterMs;
                return { allowed: false, notify, retryAfterMs, scope: 'global' };
            }

            const keyRequests = requestsByKey.get(key) || [];
            prune(keyRequests, now, windowMs);
            if (keyRequests.length >= maxPerKey) {
                const retryAfterMs = retryAfter(keyRequests, now, windowMs);
                const notify = now >= (keyNotices.get(key) || 0);
                if (notify) keyNotices.set(key, now + retryAfterMs);
                requestsByKey.set(key, keyRequests);
                return { allowed: false, notify, retryAfterMs, scope: 'user' };
            }

            keyRequests.push(now);
            globalRequests.push(now);
            requestsByKey.set(key, keyRequests);
            return { allowed: true, notify: false, retryAfterMs: 0, scope: null };
        }
    };
}

function createSendQueue(intervalMs) {
    let tail = Promise.resolve();
    let lastSentAt = 0;

    return {
        send(task) {
            const run = async () => {
                const waitMs = Math.max(0, lastSentAt + intervalMs - Date.now());
                if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
                try {
                    return await task();
                } finally {
                    lastSentAt = Date.now();
                }
            };
            const result = tail.then(run, run);
            tail = result.catch(() => {});
            return result;
        }
    };
}

module.exports = { createRequestRateLimiter, createSendQueue };
