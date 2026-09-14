FROM node:20-alpine

WORKDIR /app

# ffmpeg converts browser recordings (WebM/Opus) into the 16 kHz mono PCM WAV
# that Azure's pronunciation assessment accepts, and trims them to the clip
# length it allows. Without it pronunciation reports itself unavailable and
# everything else — transcription, marking, scoring — carries on unaffected.
RUN apk add --no-cache ffmpeg

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application
COPY . .

# Expose port
EXPOSE 5000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/api/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start application
CMD ["npm", "start"]
