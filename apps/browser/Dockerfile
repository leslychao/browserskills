# syntax=docker/dockerfile:1
FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532 AS node
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 AS build
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY package.json package-lock.json ./
COPY contracts/package.json contracts/package.json
COPY apps/browser/package.json apps/browser/package.json
COPY apps/web/package.json apps/web/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts
COPY contracts contracts
COPY apps/browser apps/browser
RUN npm run build --workspace @browserskills/browser

FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends tigervnc-standalone-server x11-utils ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/contracts ./contracts
COPY --from=build /app/apps/browser ./apps/browser
COPY tests/test-site ./tests/test-site
COPY apps/browser/start.sh /usr/local/bin/browser-start
RUN chmod 755 /usr/local/bin/browser-start && mkdir -p /data/profile /data/media /run/browser && chown -R pwuser:pwuser /data /run/browser
ENV DISPLAY=:99 PORT=3000 RFB_PORT=5900 PROFILE_DIR=/data/profile MEDIA_DIR=/data/media
USER pwuser
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/browser-start"]
