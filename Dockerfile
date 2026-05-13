FROM node:20-alpine

# Install dependencies for native modules (like libsignal or sharp)
RUN apk add --no-cache libc6-compat

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# Create the storage directory
RUN mkdir -p /app/auth_info /app/deleted_media

# Healthcheck to ensure the process is running
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD pgrep -f "node index.js" || exit 1

# Start the application
CMD ["npm", "start"]
