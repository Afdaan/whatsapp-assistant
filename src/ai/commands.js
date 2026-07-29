function getAiCommand(content) {
    if (typeof content !== 'string') return null;
    const match = content.match(/^!(ai|image|img|voice|tts|transcribe|stt|video)(?:\s+([\s\S]*))?$/i);
    if (!match) return null;

    const aliases = { img: 'image', tts: 'voice', stt: 'transcribe' };
    const name = match[1].toLowerCase();
    return { name: aliases[name] || name, prompt: (match[2] || '').trim() };
}

function getAiPrompt(content) {
    const command = getAiCommand(content);
    return command?.name === 'ai' ? command.prompt : null;
}

module.exports = { getAiCommand, getAiPrompt };
