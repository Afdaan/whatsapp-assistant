const { startAssistant } = require('./src/assistant');

if (require.main === module) {
    startAssistant();
}

module.exports = { startAssistant };
