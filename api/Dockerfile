FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN node node_modules/typescript/bin/tsc
CMD ["node", "dist/index.js"]
