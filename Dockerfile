FROM node:20-alpine

WORKDIR /app

# No npm install — this project is zero-dependency by design.
# See .github/workflows/ci.yml for the invariant check.

COPY package.json ./
COPY server.js ./

# Data directories (volumes in compose)
RUN mkdir -p /app/keys /app/logs /app/auth

EXPOSE 3040

ENV KEY_SERVER_PORT=3040 \
    KEY_SERVER_HOST=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q -O- http://localhost:3040/health || exit 1

CMD ["node", "server.js"]
