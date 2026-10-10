# Wayback Downloader: web app + job worker in one container. Node runs the TypeScript directly.
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
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/robots.txt >/dev/null || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/web/server.ts"]
