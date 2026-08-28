# WhatsApp Assistant

A Node.js-based WhatsApp assistant that helps you monitor deleted messages, save "View Once" media, and capture statuses from selected contacts/groups.

## Features

- **Anti-Delete**: Recovers deleted messages (text, images, and videos) and forwards them to your private chat ("Message Yourself"). Features a zero-storage architecture (media is downloaded dynamically from Meta's CDN upon deletion).
- **View Once Scraper**: Automatically bypasses Meta's restrictions on Companion Devices. By simply replying to a "View Once" placeholder message, the assistant exploits a synchronization loophole to automatically extract and download the hidden media.
- **Story/Status Tracker**: Tracks statuses from VIP contacts. Calculates exact survival time before deletion and forwards deleted stories with full analytics.
- **Global Status Monitor**: A "God Mode" toggle to monitor ALL status revocations globally, completely bypassing Meta's `@lid` privacy masking.
- **Private AI Assistant**: Sends `!ai` prompts to an OpenAI-compatible 9Router endpoint. Access uses a separate owner-managed user whitelist.

## Getting Started

### Option A: Local (Node.js)
1. Run `npm install` (first time only).
2. Export the AI variables shown in `.env.example`. Use `http://localhost:20128/v1` when 9Router runs on the same machine.
3. Run `npm start`.

### Option B: Docker (Recommended)
Using Docker is recommended because it keeps all dependencies isolated and manages restarts automatically.

1. **Prepare local configuration files**:
   ```bash
   cp .env.example .env
   cp whitelist.example.json whitelist.json
   cp ai_whitelist.example.json ai_whitelist.json
   printf '{}\n' > msg_cache.json
   printf '{}\n' > ai_history.json
   mkdir -p auth_info deleted_media
   chmod 600 .env whitelist.json ai_whitelist.json ai_history.json msg_cache.json
   ```
   Set `AI_API_KEY` and `AI_MODEL` in `.env`. The default Docker base URL expects 9Router on host port `20128`.
2. **Start the container**:
   ```bash
   docker-compose up -d
   ```
3. **Scan the QR code**:
   View the logs to see the QR code for linking:
   ```bash
   docker logs -f whatsapp-assistant
   ```

## Commands

Management commands can only be triggered by the account owner. Whitelisted users can only invoke `!ai`.

### Whitelist & Status Management
| Command | Description |
|---------|-------------|
| `.ping` | Check if the assistant is online and responding. |
| `.list` | Displays your VIP Whitelist and the state of the Global Status monitor. |
| `.add` | Adds the current chat to the whitelist. You can also **reply to a Status/Message** with `.add` to whitelist the sender instantly. |
| `.add 6281xx` | Adds a specific number to the whitelist (always use the country code). |
| `.add xxxx@lid` | Manually adds a Linked Device ID to the whitelist. |
| `.stories` | Lists all contacts who recently posted a story, revealing their `@lid` or `@s.whatsapp.net` for easy whitelisting. |
| `.del` | Removes the current chat from the whitelist. |
| `.status on` | Turns ON the Global Status Monitor (monitors all contacts, bypassing LID restrictions). |
| `.status off`| Turns OFF the Global Status Monitor (reverts to VIP Whitelist only). |

### View Once Interception
| Command | Description |
|---------|-------------|
| *(Auto)* | When you see a "View Once" placeholder, simply **reply to it with any text** (e.g., "a"). The bot detects the hidden `viewOnce` flag and extracts the media automatically. |
| `.scrap` | Manual fallback command. Reply to a "View Once" placeholder with `.scrap` to forcibly attempt extraction. |
| `.groups`| List all your groups with their IDs (JIDs). |

### AI Assistant
| Command | Description |
|---------|-------------|
| `!ai <prompt>` | Ask the chat model. Supports replied/captioned images, stickers, audio, video, and documents. |
| `!ai reset` | Delete local AI memory for the current private chat or group identity. Alias: `!ai clear`. |
| `!image <prompt>` | Generate and send an image. Alias: `!img`. |
| `!voice <text>` | Generate and send speech audio. OGG/Opus responses are sent as voice notes. Alias: `!tts`. |
| `!transcribe` | Reply to a voice note/audio to transcribe it. Alias: `!stt`. |
| `!video <prompt>` | Start an asynchronous video generation job, poll it, then send the resulting video. |
| `/ai on` or `.ai on` | Owner-only. Enable the AI assistant globally. |
| `/ai off` or `.ai off` | Owner-only. Disable the AI assistant globally. |
| `/ai status` or `.ai status` | Owner-only. Check AI assistant enabled status. |
| `.aiadd 6281xx` | Owner-only. Grant AI access to a phone number (also works with `/aiadd`). |
| `.aiadd <JID>` | Owner-only. Grant access to an exact `@s.whatsapp.net` or `@lid` identity. Replying to a private message also works. |
| `.aidel <number/JID>` | Owner-only. Revoke AI access (also works with `/aidel`). |
| `.ailist` | Owner-only. Show the AI whitelist and global AI status (also works with `/ailist`). |

AI access is intentionally separate from the status/anti-delete whitelist. The AI whitelist protects private chat and media commands. The owner can globally toggle AI availability using `/ai on` or `/ai off` (state persisted in `ai_state.json`). Group usage is disabled by default. When `AI_ALLOW_GROUPS=true`, every member of an explicitly whitelisted group can use AI commands; run `.add` inside the group or `.add <group-JID>`. Other groups remain blocked. Unauthorized private-chat AI commands receive no reply. Each user can run only one AI request at a time, and downloaded/generated media is rejected above `AI_MEDIA_MAX_BYTES`.

AI requests are rate-limited per user and globally. Repeated denied requests receive at most one warning per limit window. All outgoing WhatsApp messages also use a shared send queue to avoid bursts. These controls reduce spam risk but cannot guarantee that WhatsApp will never restrict the account.

Successful `!ai` conversations are stored locally in `ai_history.json`. Private memory is isolated per chat; group memory is isolated per group and sender. Only text prompts and model replies are stored, never image data. The default context is the latest 8 messages (4 user/assistant turns).

Whitelisted private users can send media directly without a command. Groups still require `!ai` in the media caption or as a reply to avoid processing every group upload. Images and stickers are sent as vision input. Audio is sent as audio input and transcribed when `AI_STT_MODEL` is configured. Video uses a representative frame plus optional audio transcription because 9Router has no OpenAI-compatible video block for chat. PDFs and other documents use file input; plain-text documents are embedded as bounded text.

The system prompt lives in `prompts/system.txt`. It is read for every chat request, so edits apply without rebuilding or restarting the container. Keep this file free of secrets because its contents are sent to the configured model provider.

Required AI configuration:

| Variable | Description |
|----------|-------------|
| `AI_BASE_URL` | OpenAI-compatible base URL ending in `/v1`. |
| `AI_API_KEY` | 9Router API key. |
| `AI_MODEL` | Chat/vision model or combo ID. |
| `AI_IMAGE_MODEL` | Image generation model ID; enables `!image`. |
| `AI_TTS_MODEL` | Text-to-speech model/voice ID; enables `!voice`. |
| `AI_STT_MODEL` | Speech-to-text model ID; enables `!transcribe`. |
| `AI_VIDEO_MODEL` | Video generation model ID; enables `!video`. |
| `AI_SYSTEM_PROMPT_FILE` | Prompt path; default `prompts/system.txt`. |
| `AI_TIMEOUT_MS` | Request timeout; default `60000`. |
| `AI_VIDEO_TIMEOUT_MS` | Full create/poll/download timeout; default `600000`. |
| `AI_VIDEO_POLL_MS` | Video polling interval; default `5000`. |
| `AI_MAX_TOKENS` | Maximum completion tokens; default `1000`. |
| `AI_MAX_PROMPT_CHARS` | Maximum prompt length; default `4000`. |
| `AI_HISTORY_MAX_MESSAGES` | Local context entries per chat identity; default `8` (4 turns), maximum `40`. |
| `AI_RATE_LIMIT_WINDOW_MS` | AI request limit window; default `60000` (1 minute). |
| `AI_RATE_LIMIT_MAX_REQUESTS` | Accepted AI commands per user/window; default `5`. |
| `AI_RATE_LIMIT_GLOBAL_MAX_REQUESTS` | Accepted AI commands across all users/window; default `20`. |
| `AI_MEDIA_MAX_BYTES` | Maximum input/output media size; default `20971520` bytes. |
| `AI_ALLOW_GROUPS` | Allow every member to use AI inside explicitly whitelisted groups. Default `false`. |
| `WHATSAPP_SEND_INTERVAL_MS` | Minimum interval between all outbound WhatsApp messages; default `1500`. |

## Architectural Details
- **Zero-Storage Statuses**: Statuses are tracked entirely in RAM (`msgCache`). Media is only downloaded from Meta's CDN when a `REVOKE` (delete) event is detected. This prevents server disk bloat.
- **Linked Device Masking**: Meta hides actual phone numbers in Status broadcasts using cryptographic `@lid` (Linked Device IDs). Use `.status on` or reply to a status with `.add` to easily circumvent this masking.
- **View Once Loophole**: WhatsApp Web/Linked Devices are blocked from opening View Once media. This bot exploits a protocol behavior where quoting (replying to) the placeholder message from your primary phone temporarily exposes the decrypted payload to companion devices.

## Project Structure
- `index.js`: Minimal process entrypoint.
- `src/assistant.js`: WhatsApp socket lifecycle and event routing.
- `src/config.js`: Runtime paths and environment configuration.
- `src/storage.js`: Whitelist and message-cache persistence.
- `src/media.js`: Bounded WhatsApp media download and text sending helpers.
- `src/rate-limit.js`: AI request limits and global outbound message pacing.
- `src/ai/client.js`: OpenAI-compatible chat, image, TTS, STT, and video API client.
- `src/ai/handler.js`: AI authorization and WhatsApp command execution.
- `src/ai/media-input.js`: WhatsApp media preparation for multimodal chat input.
- `src/ai/commands.js`: AI command parsing and aliases.
- `src/whatsapp/content-handlers.js`: View Once, status, and anti-delete handlers.
- `src/whatsapp/owner-commands.js`: Owner-only management commands.
- `src/whatsapp/message-utils.js`: Message unwrapping and JID/message helpers.
- `auth_info/`: Stores your session data (Docker mounted).
- `deleted_media/`: Where View Once media files are stored locally.
- `prompts/system.txt`: Live-reloaded AI system prompt.
- `whitelist.json`: List of monitored VIP chats (Docker mounted).
- `ai_whitelist.json`: Separate list of users allowed to invoke the AI assistant (Docker mounted).
- `ai_history.json`: Local bounded AI conversation memory (Docker mounted, gitignored).
- `ai_state.json`: Global AI enable/disable toggle state (Docker mounted, gitignored).
