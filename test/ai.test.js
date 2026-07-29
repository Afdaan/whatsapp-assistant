const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    generateImage,
    generateSpeech,
    generateVideo,
    readSystemPrompt,
    requestAi,
    transcribeAudio
} = require('../src/ai/client');
const { getAiCommand, getAiPrompt } = require('../src/ai/commands');
const { isAiAuthorized } = require('../src/ai/handler');
const { normalizeUserJid } = require('../src/identifiers');
const { createMessageCache, createWhitelistStore } = require('../src/storage');

test('normalizes only user JIDs', () => {
    assert.equal(normalizeUserJid('+62 812-3456'), '628123456@s.whatsapp.net');
    assert.equal(normalizeUserJid('628123456:17@s.whatsapp.net'), '628123456@s.whatsapp.net');
    assert.equal(normalizeUserJid('12345@lid'), '12345@lid');
    assert.equal(normalizeUserJid('1203630@g.us'), null);
});

test('parses only the exact !ai command', () => {
    assert.equal(getAiPrompt('!ai halo'), 'halo');
    assert.equal(getAiPrompt('!AI\njelaskan ini'), 'jelaskan ini');
    assert.equal(getAiPrompt('!ai'), '');
    assert.equal(getAiPrompt('!aix halo'), null);
    assert.deepEqual(getAiCommand('!img buat kucing'), { name: 'image', prompt: 'buat kucing' });
    assert.deepEqual(getAiCommand('!tts halo'), { name: 'voice', prompt: 'halo' });
    assert.deepEqual(getAiCommand('!stt'), { name: 'transcribe', prompt: '' });
    assert.deepEqual(getAiCommand('!video hujan'), { name: 'video', prompt: 'hujan' });
});

test('reloads the system prompt from text file', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ai-prompt-'));
    const promptPath = path.join(directory, 'system.txt');
    try {
        fs.writeFileSync(promptPath, 'prompt pertama');
        assert.equal(readSystemPrompt({ systemPromptPath: promptPath }), 'prompt pertama');
        fs.writeFileSync(promptPath, 'prompt kedua');
        assert.equal(readSystemPrompt({ systemPromptPath: promptPath }), 'prompt kedua');
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('sends an OpenAI-compatible chat completion request', async () => {
    let requestBody;
    let authorization;
    const server = http.createServer((request, response) => {
        authorization = request.headers.authorization;
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
            requestBody = JSON.parse(body);
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ choices: [{ message: { content: 'jawaban test' } }] }));
        });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
        const answer = await requestAi('halo', {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: 'secret',
            model: 'test/model',
            systemPrompt: 'system test',
            timeoutMs: 1000,
            maxTokens: 321
        }, { buffer: Buffer.from('image'), mimetype: 'image/png' });

        assert.equal(answer, 'jawaban test');
        assert.equal(authorization, 'Bearer secret');
        assert.equal(requestBody.model, 'test/model');
        assert.equal(requestBody.max_tokens, 321);
        assert.deepEqual(requestBody.messages, [
            { role: 'system', content: 'system test' },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'halo' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }
                ]
            }
        ]);
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test('rejects incomplete AI configuration', async () => {
    await assert.rejects(
        requestAi('halo', {
            baseUrl: 'http://127.0.0.1:1/v1',
            apiKey: '',
            model: 'test/model'
        }),
        /AI_NOT_CONFIGURED/
    );
});

test('handles image, speech, and transcription endpoints', async () => {
    const requests = [];
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            requests.push({
                url: request.url,
                authorization: request.headers.authorization,
                contentType: request.headers['content-type'],
                body: Buffer.concat(chunks)
            });

            if (request.url.startsWith('/v1/images/generations')) {
                response.writeHead(200, { 'Content-Type': 'image/png' });
                response.end('png-data');
            } else if (request.url === '/v1/audio/speech') {
                response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
                response.end('mp3-data');
            } else {
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ text: 'hasil transkrip' }));
            }
        });
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const config = {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'secret',
        imageModel: 'image/model',
        ttsModel: 'tts/model',
        sttModel: 'stt/model',
        timeoutMs: 1000,
        mediaMaxBytes: 1024
    };

    try {
        const image = await generateImage('gambar kucing', config);
        const speech = await generateSpeech('halo', config);
        const transcript = await transcribeAudio(Buffer.from('ogg-data'), 'audio/ogg', config);
        await assert.rejects(
            generateImage('terlalu besar', { ...config, mediaMaxBytes: 3 }),
            /AI_MEDIA_TOO_LARGE/
        );

        assert.equal(image.buffer.toString(), 'png-data');
        assert.equal(image.mimetype, 'image/png');
        assert.equal(speech.buffer.toString(), 'mp3-data');
        assert.equal(speech.mimetype, 'audio/mpeg');
        assert.equal(transcript, 'hasil transkrip');
        assert.equal(requests.length, 4);
        assert.equal(requests[0].url, '/v1/images/generations?response_format=binary');
        assert.equal(JSON.parse(requests[0].body).model, 'image/model');
        assert.equal(JSON.parse(requests[1].body).model, 'tts/model');
        assert.match(requests[2].contentType, /^multipart\/form-data; boundary=/);
        assert.match(requests[2].body.toString(), /stt\/model/);
        assert.ok(requests.every(request => request.authorization === 'Bearer secret'));
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test('creates, polls, and downloads an async video job', async () => {
    let pollConnectionId;
    const server = http.createServer((request, response) => {
        if (request.method === 'POST' && request.url === '/v1/videos/generations') {
            response.writeHead(200, {
                'Content-Type': 'application/json',
                'x-9router-connection-id': 'connection-1'
            });
            response.end(JSON.stringify({ request_id: 'job-1' }));
            return;
        }

        if (request.url === '/v1/videos/job-1') {
            pollConnectionId = request.headers['x-connection-id'];
            const { port } = server.address();
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({
                status: 'done',
                video: { url: `http://127.0.0.1:${port}/generated.mp4` }
            }));
            return;
        }

        response.writeHead(200, { 'Content-Type': 'video/mp4' });
        response.end('mp4-data');
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        const video = await generateVideo('video test', {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: 'secret',
            videoModel: 'xai/grok-imagine-video',
            videoTimeoutMs: 1000,
            videoPollMs: 1,
            mediaMaxBytes: 1024
        });

        assert.equal(video.buffer.toString(), 'mp4-data');
        assert.equal(video.mimetype, 'video/mp4');
        assert.equal(pollConnectionId, 'connection-1');
    } finally {
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
});

test('persists whitelist changes and enforces message cache size', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-storage-'));
    const whitelistPath = path.join(directory, 'whitelist.json');
    const cachePath = path.join(directory, 'cache.json');

    try {
        const whitelist = createWhitelistStore(whitelistPath, normalizeUserJid);
        assert.equal(whitelist.add('+62 812-3456'), true);
        assert.equal(whitelist.add('628123456@s.whatsapp.net'), false);
        assert.deepEqual(whitelist.entries(), ['628123456@s.whatsapp.net']);

        const reloadedWhitelist = createWhitelistStore(whitelistPath, normalizeUserJid);
        assert.equal(reloadedWhitelist.includes('628123456@s.whatsapp.net'), true);
        assert.equal(reloadedWhitelist.remove('628123456@s.whatsapp.net'), true);

        const cache = createMessageCache(cachePath, 2);
        cache.set('one', { value: 1 });
        cache.set('two', { value: 2 });
        cache.set('three', { value: 3 });
        assert.equal(cache.get('one'), undefined);
        assert.deepEqual(cache.get('three'), { value: 3 });
        cache.save();

        const reloadedCache = createMessageCache(cachePath, 2);
        assert.deepEqual(reloadedCache.get('two'), { value: 2 });
        assert.deepEqual(reloadedCache.get('three'), { value: 3 });
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('requires both sender and group whitelists for group AI access', () => {
    const aiWhitelist = { includes: value => value === '6281@s.whatsapp.net' };
    const groupWhitelist = { includes: value => value === 'allowed@g.us' };

    assert.equal(isAiAuthorized({
        aiWhitelist,
        allowGroups: true,
        groupWhitelist,
        isFromMe: false,
        remoteJid: '6281@s.whatsapp.net',
        senderJid: '6281@s.whatsapp.net'
    }), true);
    assert.equal(isAiAuthorized({
        aiWhitelist,
        allowGroups: true,
        groupWhitelist,
        isFromMe: false,
        remoteJid: 'blocked@g.us',
        senderJid: '6281@s.whatsapp.net'
    }), false);
    assert.equal(isAiAuthorized({
        aiWhitelist,
        allowGroups: false,
        groupWhitelist,
        isFromMe: false,
        remoteJid: 'allowed@g.us',
        senderJid: '6281@s.whatsapp.net'
    }), false);
    assert.equal(isAiAuthorized({
        aiWhitelist,
        allowGroups: true,
        groupWhitelist,
        isFromMe: false,
        remoteJid: 'allowed@g.us',
        senderJid: 'unauthorized@s.whatsapp.net'
    }), false);
    assert.equal(isAiAuthorized({
        aiWhitelist,
        allowGroups: true,
        groupWhitelist,
        isFromMe: true,
        remoteJid: 'blocked@g.us',
        senderJid: 'owner@s.whatsapp.net'
    }), false);
    assert.equal(isAiAuthorized({
        aiWhitelist,
        allowGroups: true,
        groupWhitelist,
        isFromMe: true,
        remoteJid: 'allowed@g.us',
        senderJid: 'owner@s.whatsapp.net'
    }), true);
});
