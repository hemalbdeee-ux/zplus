# zplus.ai: web app + job worker in one container (each job in its own child process).
# Node runs the TypeScript directly.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY content ./content
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=8080 WBD_DATA=/data
EXPOSE 8080
# Traefik routes no traffic to a container until it is healthy: in the first 30 s it is checked
# every 2 s, so the site is back within seconds of a start (--start-interval needs Docker Engine 25+).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s CMD wget -qO- http://127.0.0.1:8080/robots.txt >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/web/server.ts"]
