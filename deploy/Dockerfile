FROM node:24.14.0-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/satoshi-ltd/arca"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY packages ./packages
COPY apps/desktop/src ./apps/desktop/src
RUN mkdir -p /data/state /data/files && chown -R node:node /data
USER node
ENV ARCA_HOME=/data/state
EXPOSE 47831
ENTRYPOINT ["node", "packages/cli/arca.js"]
CMD ["daemon", "--host", "0.0.0.0", "--private-network"]
