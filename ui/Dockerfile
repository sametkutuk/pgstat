FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN node node_modules/.bin/vite build --mode production

FROM nginx:alpine
RUN addgroup -g 1000 pgstat && adduser -D -u 1000 -G pgstat pgstat
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
RUN chown -R pgstat:pgstat /usr/share/nginx/html \
    && chown -R pgstat:pgstat /var/cache/nginx \
    && chown -R pgstat:pgstat /var/log/nginx \
    && touch /var/run/nginx.pid \
    && chown pgstat:pgstat /var/run/nginx.pid
EXPOSE 80
