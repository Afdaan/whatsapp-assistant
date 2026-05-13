# WhatsApp Assistant

A Node.js-based WhatsApp assistant that helps you monitor deleted messages, save "View Once" media, and capture statuses from selected contacts/groups.

## Features

- **Anti-Delete**: Recovers deleted messages (text, images, and videos) and forwards them to your private chat ("Message Yourself"). Features a zero-storage architecture (media is downloaded dynamically from Meta's CDN upon deletion).
- **View Once Scraper**: Automatically bypasses Meta's restrictions on Companion Devices. By simply replying to a "View Once" placeholder message, the assistant exploits a synchronization loophole to automatically extract and download the hidden media.
- **Story/Status Tracker**: Tracks statuses from VIP contacts. Calculates exact survival time before deletion and forwards deleted stories with full analytics.
- **Global Status Monitor**: A "God Mode" toggle to monitor ALL status revocations globally, completely bypassing Meta's `@lid` privacy masking.

## Getting Started

### Option A: Local (Node.js)
1. Run `npm install` (first time only).
2. Run `npm start`.

### Option B: Docker (Recommended)
Using Docker is recommended because it keeps all dependencies isolated and manages restarts automatically.

1. **Start the container**:
   ```bash
   docker-compose up -d
   ```
2. **Scan the QR code**:
   View the logs to see the QR code for linking:
   ```bash
   docker logs -f whatsapp-assistant
   ```

## Commands

Use these commands directly in any WhatsApp chat. **Only you (the account owner) can trigger these commands.** You can execute them in your "Message Yourself" chat to remain hidden.

### Whitelist & Status Management
| Command | Description |
|---------|-------------|
| `.ping` | Check if the assistant is online and responding. |
| `.list` | Displays your VIP Whitelist and the state of the Global Status monitor. |
| `.add` | Adds the current chat to the whitelist. You can also **reply to a Status/Message** with `.add` to whitelist the sender instantly. |
| `.add 6281xx` | Adds a specific number to the whitelist (always use the country code). |
| `.add xxxx@lid` | Manually adds a Linked Device ID to the whitelist. |
| `.del` | Removes the current chat from the whitelist. |
| `.status on` | Turns ON the Global Status Monitor (monitors all contacts, bypassing LID restrictions). |
| `.status off`| Turns OFF the Global Status Monitor (reverts to VIP Whitelist only). |

### View Once Interception
| Command | Description |
|---------|-------------|
| *(Auto)* | When you see a "View Once" placeholder, simply **reply to it with any text** (e.g., "a"). The bot detects the hidden `viewOnce` flag and extracts the media automatically. |
| `.scrap` | Manual fallback command. Reply to a "View Once" placeholder with `.scrap` to forcibly attempt extraction. |
| `.groups`| List all your groups with their IDs (JIDs). |

## Architectural Details
- **Zero-Storage Statuses**: Statuses are tracked entirely in RAM (`msgCache`). Media is only downloaded from Meta's CDN when a `REVOKE` (delete) event is detected. This prevents server disk bloat.
- **Linked Device Masking**: Meta hides actual phone numbers in Status broadcasts using cryptographic `@lid` (Linked Device IDs). Use `.status on` or reply to a status with `.add` to easily circumvent this masking.
- **View Once Loophole**: WhatsApp Web/Linked Devices are blocked from opening View Once media. This bot exploits a protocol behavior where quoting (replying to) the placeholder message from your primary phone temporarily exposes the decrypted payload to companion devices.

## Project Structure
- `index.js`: Main application logic.
- `auth_info/`: Stores your session data (Docker mounted).
- `deleted_media/`: Where View Once media files are stored locally.
- `whitelist.json`: List of monitored VIP chats (Docker mounted).
