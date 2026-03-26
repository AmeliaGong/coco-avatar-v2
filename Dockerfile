FROM node:20-slim

# Install build tools for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y python3 build-essential && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --include=dev
COPY . .
RUN npm run build
RUN npm prune --production

# Create data directory for SQLite
RUN mkdir -p /data

ENV DB_PATH=/data/coco.db

EXPOSE 8080
CMD ["node", "server.js"]
