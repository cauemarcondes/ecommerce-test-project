FROM node:18-alpine

WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY src/ ./src/

# Set environment variables
ENV NODE_ENV=production

# Start the service
CMD ["node", "src/index.js"]
