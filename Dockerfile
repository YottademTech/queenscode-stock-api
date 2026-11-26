# The stock server as a container, for any host that runs one. Node runs the TypeScript as it is.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY drizzle ./drizzle
COPY src ./src

USER node
EXPOSE 8791
CMD ["node", "src/serve.ts"]
