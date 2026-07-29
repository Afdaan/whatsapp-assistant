const fs = require('node:fs');
const { AI_CONFIG } = require('../config');
const { getExtension } = require('../media');

function readSystemPrompt(config = AI_CONFIG) {
    if (typeof config.systemPrompt === 'string' && config.systemPrompt.trim()) {
        return config.systemPrompt.trim();
    }

    const prompt = fs.readFileSync(config.systemPromptPath, 'utf8').trim();
    if (!prompt) throw new Error('AI_SYSTEM_PROMPT_EMPTY');
    return prompt;
}

function aiHeaders(config, json = true) {
    const headers = { Authorization: `Bearer ${config.apiKey}` };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
}

function responseMimetype(response, fallback) {
    return (response.headers.get('content-type') || fallback).split(';')[0].trim();
}

async function readBoundedBuffer(response, maxBytes) {
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error('AI_MEDIA_TOO_LARGE');
    }

    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of response.body) {
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) throw new Error('AI_MEDIA_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
}

async function requestAi(prompt, config = AI_CONFIG, image = null) {
    if (!config.baseUrl || !config.apiKey || !config.model) throw new Error('AI_NOT_CONFIGURED');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
        const response = await fetch(`${config.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: aiHeaders(config),
            signal: controller.signal,
            body: JSON.stringify({
                model: config.model,
                messages: [
                    { role: 'system', content: readSystemPrompt(config) },
                    {
                        role: 'user',
                        content: image ? [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: `data:${image.mimetype};base64,${image.buffer.toString('base64')}` } }
                        ] : prompt
                    }
                ],
                max_tokens: config.maxTokens,
                stream: false
            })
        });
        if (!response.ok) throw new Error(`AI_HTTP_${response.status}`);

        const data = await response.json();
        const answer = data?.choices?.[0]?.message?.content;
        if (typeof answer !== 'string' || !answer.trim()) throw new Error('AI_INVALID_RESPONSE');
        return answer.trim();
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('AI_TIMEOUT');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function generateImage(prompt, config = AI_CONFIG) {
    if (!config.baseUrl || !config.apiKey || !config.imageModel) throw new Error('AI_IMAGE_NOT_CONFIGURED');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
        const response = await fetch(`${config.baseUrl}/images/generations?response_format=binary`, {
            method: 'POST',
            headers: aiHeaders(config),
            signal: controller.signal,
            body: JSON.stringify({ model: config.imageModel, prompt })
        });
        if (!response.ok) throw new Error(`AI_IMAGE_HTTP_${response.status}`);
        return {
            buffer: await readBoundedBuffer(response, config.mediaMaxBytes),
            mimetype: responseMimetype(response, 'image/png')
        };
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('AI_IMAGE_TIMEOUT');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function generateSpeech(text, config = AI_CONFIG) {
    if (!config.baseUrl || !config.apiKey || !config.ttsModel) throw new Error('AI_TTS_NOT_CONFIGURED');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
        const response = await fetch(`${config.baseUrl}/audio/speech`, {
            method: 'POST',
            headers: aiHeaders(config),
            signal: controller.signal,
            body: JSON.stringify({ model: config.ttsModel, input: text })
        });
        if (!response.ok) throw new Error(`AI_TTS_HTTP_${response.status}`);
        return {
            buffer: await readBoundedBuffer(response, config.mediaMaxBytes),
            mimetype: responseMimetype(response, 'audio/mpeg')
        };
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('AI_TTS_TIMEOUT');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function transcribeAudio(buffer, mimetype, config = AI_CONFIG) {
    if (!config.baseUrl || !config.apiKey || !config.sttModel) throw new Error('AI_STT_NOT_CONFIGURED');
    if (buffer.length > config.mediaMaxBytes) throw new Error('AI_MEDIA_TOO_LARGE');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const form = new FormData();
    form.append('model', config.sttModel);
    form.append('file', new Blob([buffer], { type: mimetype }), `audio.${getExtension(mimetype)}`);

    try {
        const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: aiHeaders(config, false),
            signal: controller.signal,
            body: form
        });
        if (!response.ok) throw new Error(`AI_STT_HTTP_${response.status}`);
        const data = await response.json();
        if (typeof data?.text !== 'string' || !data.text.trim()) throw new Error('AI_STT_INVALID_RESPONSE');
        return data.text.trim();
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('AI_STT_TIMEOUT');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function generateVideo(prompt, config = AI_CONFIG) {
    if (!config.baseUrl || !config.apiKey || !config.videoModel) throw new Error('AI_VIDEO_NOT_CONFIGURED');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.videoTimeoutMs);
    try {
        const createResponse = await fetch(`${config.baseUrl}/videos/generations`, {
            method: 'POST',
            headers: aiHeaders(config),
            signal: controller.signal,
            body: JSON.stringify({ model: config.videoModel, prompt })
        });
        if (!createResponse.ok) throw new Error(`AI_VIDEO_HTTP_${createResponse.status}`);

        const connectionId = createResponse.headers.get('x-9router-connection-id');
        const job = await createResponse.json();
        if (!job?.request_id) throw new Error('AI_VIDEO_INVALID_RESPONSE');

        while (!controller.signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, config.videoPollMs));
            const headers = aiHeaders(config, false);
            if (connectionId) headers['x-connection-id'] = connectionId;
            const pollResponse = await fetch(`${config.baseUrl}/videos/${encodeURIComponent(job.request_id)}`, {
                headers,
                signal: controller.signal
            });
            if (!pollResponse.ok) throw new Error(`AI_VIDEO_POLL_HTTP_${pollResponse.status}`);

            const status = await pollResponse.json();
            if (status.status === 'failed') throw new Error('AI_VIDEO_FAILED');
            if (status.status !== 'done') continue;
            if (!status.video?.url) throw new Error('AI_VIDEO_INVALID_RESPONSE');

            const videoUrl = new URL(status.video.url);
            if (!['http:', 'https:'].includes(videoUrl.protocol)) throw new Error('AI_VIDEO_INVALID_URL');
            const videoResponse = await fetch(videoUrl, { signal: controller.signal });
            if (!videoResponse.ok) throw new Error(`AI_VIDEO_DOWNLOAD_HTTP_${videoResponse.status}`);
            return {
                buffer: await readBoundedBuffer(videoResponse, config.mediaMaxBytes),
                mimetype: responseMimetype(videoResponse, 'video/mp4')
            };
        }

        throw new Error('AI_VIDEO_TIMEOUT');
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('AI_VIDEO_TIMEOUT');
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

module.exports = {
    generateImage,
    generateSpeech,
    generateVideo,
    readSystemPrompt,
    requestAi,
    transcribeAudio
};
