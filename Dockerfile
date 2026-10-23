FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json app.js server.js ./
COPY public ./public
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO /dev/null http://127.0.0.1:3000/ || exit 1
CMD ["node", "server.js"]
