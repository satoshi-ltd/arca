FROM node:24.14.0-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/satoshi-ltd/arca"
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY packages ./packages
COPY apps/desktop/src ./apps/desktop/src
RUN mkdir -p /data/state /data/files && chown -R node:node /data
USER node
ENV ARCA_HOME=/data/state ARCA_FILES=/data/files
EXPOSE 17831
ENTRYPOINT ["node", "packages/cli/arca.js"]
CMD ["daemon", "--setup", "--port", "17831", "--host", "0.0.0.0", "--private-network"]
