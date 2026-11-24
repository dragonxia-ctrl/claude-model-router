FROM node:22-alpine

LABEL org.opencontainers.image.title="claude-model-router" \
      org.opencontainers.image.description="Local routing proxy that selects DeepSeek or Kimi for Claude Code" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
ENV NODE_ENV=production \
    CLAUDE_ROUTER_CONFIG=/data/config.json

COPY package.json ./
COPY src ./src
COPY scripts/healthcheck.mjs ./scripts/healthcheck.mjs

EXPOSE 17861
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "scripts/healthcheck.mjs"]

CMD ["node", "src/router.mjs"]
