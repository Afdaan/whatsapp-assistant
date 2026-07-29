const fs = require('fs-extra');

function createWhitelistStore(filePath, normalize = value => value) {
    let values = [];

    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
        try {
            const stored = fs.readJsonSync(filePath);
            if (Array.isArray(stored)) {
                values = [...new Set(stored.map(normalize).filter(Boolean))];
            }
        } catch (error) {
            console.error(`Failed to load whitelist ${filePath}: ${error.message}`);
        }
    }

    const save = () => fs.writeJsonSync(filePath, values);

    return {
        add(value) {
            const normalized = normalize(value);
            if (!normalized || values.includes(normalized)) return false;
            values.push(normalized);
            save();
            return true;
        },
        entries() {
            return [...values];
        },
        includes(value) {
            const normalized = normalize(value);
            return Boolean(normalized && values.includes(normalized));
        },
        remove(value) {
            const normalized = normalize(value);
            if (!normalized) return false;
            const next = values.filter(entry => entry !== normalized);
            const changed = next.length !== values.length;
            values = next;
            save();
            return changed;
        }
    };
}

function createMessageCache(filePath, maxSize) {
    let messages = new Map();

    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
        try {
            messages = new Map(Object.entries(fs.readJsonSync(filePath)));
        } catch (error) {
            console.error(`Failed to load message cache: ${error.message}`);
        }
    }

    return {
        entries() {
            return messages.entries();
        },
        get(id) {
            return messages.get(id);
        },
        save() {
            try {
                fs.writeJsonSync(filePath, Object.fromEntries(messages));
            } catch (error) {
                console.error(`Failed to save message cache: ${error.message}`);
            }
        },
        set(id, message) {
            messages.set(id, message);
            if (messages.size > maxSize) {
                messages.delete(messages.keys().next().value);
            }
        },
        size() {
            return messages.size;
        }
    };
}

module.exports = { createMessageCache, createWhitelistStore };
