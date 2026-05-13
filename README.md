# WhatsApp Assistant

A Node.js-based WhatsApp assistant that helps you monitor deleted messages, save "View Once" media, and capture statuses from selected contacts/groups.

## Features

- **Anti-Delete**: Recovers deleted messages (text, images, and videos) and forwards them to your private chat.
- **View Once Saver**: Intercepts "View Once" media and saves a permanent copy.
- **Status/Story Saver**: Automatically captures statuses from whitelisted contacts and saves them to `deleted_media/`.
- **Whitelist System**: Only monitors specific chats/contacts to keep your logs clean and relevant.

## Getting Started

### 1. Start the Assistant
In your terminal, run:
```bash
npm start
```

### 2. Link WhatsApp
- A QR code will appear in the terminal.
- Open WhatsApp on your phone.
- Go to **Settings > Linked Devices > Link a Device**.
- Scan the QR code.

## Commands

Use these commands directly in any WhatsApp chat to manage your monitoring list. **Only you (the account owner) can trigger these commands.**

| Command | Description |
|---------|-------------|
| `.ping` | Check if the assistant is online and responding. |
| `.groups` | List all your groups with their IDs (JIDs). |
| `.add` | Adds the current chat to the whitelist. |
| `.add 6281xx` | Adds a specific number to the whitelist. |
| `.add xxxx@g.us` | Adds a group by ID (see `.groups` for IDs). |
| `.del` | Removes the current chat from the whitelist. |
| `.list` | Displays a list of all whitelisted JIDs (IDs). |

### Important Tips
- **To Save Statuses**: Open a private chat with the person whose status you want to save, and type `.add`.
- **Deleted Media**: All intercepted files are stored in the `deleted_media/` folder in this project directory.
- **Memory**: The assistant captures messages in real-time. It cannot recover messages that were deleted *before* you started the script.

## Project Structure
- `index.js`: Main application logic.
- `auth_info/`: Stores your session data (do not delete unless you want to re-scan).
- `deleted_media/`: Where all saved media files are stored.
- `whitelist.json`: List of monitored chats.
- `baileys_store.json`: Cached message store.
