FROM node:20-alpine
RUN addgroup -g 10001 pgstat 2>/dev/null || true && \
    adduser -D -u 10001 -G pgstat pgstat 2>/dev/null || true
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN node node_modules/typescript/bin/tsc
RUN chown -R 10001:10001 /app
RUN mkdir -p /app/data/secrets && chown -R 10001:10001 /app/data
USER 10001
CMD ["node", "dist/index.js"]
