# WhatsApp Assistant

A Node.js-based WhatsApp assistant that helps you monitor deleted messages, save "View Once" media, and capture statuses from selected contacts/groups.

## Features

- **Anti-Delete**: Recovers deleted messages (text, images, and videos) and forwards them to your private chat.
- **View Once Saver**: Intercepts "View Once" media and saves a permanent copy.
- **Status/Story Saver**: Automatically captures statuses from whitelisted contacts and saves them to `deleted_media/`.
- **Whitelist System**: Only monitors specific chats/contacts to keep your logs clean and relevant.

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

## Volume Mounting (Persistence)
When using Docker, we use **Volumes** to mount the following files/folders from your computer into the container:
- `auth_info/`: Keeps you logged in after restarts.
- `deleted_media/`: Where your saved photos/videos are stored.
- `whitelist.json`: Your monitoring settings.
- `msg_cache.json`: The message memory.

This ensures that even if you delete the container or update the image, your assistant won't "forget" your settings or log you out.

## CI/CD (Self-Hosted Runner)
The project includes a GitHub Actions workflow in `.github/workflows/deploy.yml`. 
If you have a **self-hosted GitHub runner** set up on your server:
1. Every time you `push` to the `main` branch, the runner will automatically pull the new code.
2. It will run `docker-compose up --build -d` to update the assistant without losing your session (thanks to the volume mounting).

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
