FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY backend ./backend
COPY scripts ./scripts
COPY index.html app.js styles.css server.js ./
RUN npm run build \
  && mkdir -p /var/lib/rased/uploads /var/lib/rased/reports \
  && chown -R node:node /app /var/lib/rased
USER node
EXPOSE 8080
CMD ["node","server.js"]
