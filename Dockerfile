# Full Node runtime retains PostgreSQL, Chromium sandboxing and background work.
FROM node:24.15.0-bookworm AS build
WORKDIR /app
ENV HUSKY=0
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci --prefix frontend --no-audit --no-fund
COPY . .
RUN node node_modules/yarn/bin/yarn.js --cwd modules/excalidraw install --frozen-lockfile --non-interactive --ignore-scripts
ENV NEXT_PUBLIC_PROMPTMASTER_DEMO_API_ENABLED=true
RUN npm run build
RUN npm prune --prefix frontend --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24.15.0-bookworm-slim AS runtime
WORKDIR /app/frontend
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build /app/frontend/package.json /app/frontend/package-lock.json ./
COPY --from=build /app/frontend/next.config.ts ./next.config.ts
COPY --from=build /app/frontend/node_modules ./node_modules
RUN node node_modules/playwright/cli.js install --with-deps chromium && chmod -R a+rX /ms-playwright
COPY --from=build --chown=node:node /app/frontend/.next ./.next
COPY --from=build --chown=node:node /app/frontend/public ./public
COPY --from=build --chown=node:node /app/frontend/migrations ./migrations
COPY --from=build --chown=node:node /app/frontend/scripts/migrate.mjs /app/frontend/scripts/initialize-accounts.mjs ./scripts/
COPY --from=build --chown=node:node /app/scripts/start-cloud.mjs /app/scripts/cloud-config.mjs /app/scripts/
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/scripts/start-cloud.mjs"]
