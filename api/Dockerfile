FROM node:20-alpine
RUN addgroup -g 1000 pgstat && adduser -D -u 1000 -G pgstat pgstat
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN node node_modules/typescript/bin/tsc
RUN chown -R pgstat:pgstat /app
USER pgstat
CMD ["node", "dist/index.js"]
