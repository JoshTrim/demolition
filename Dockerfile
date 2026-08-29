FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
# The build can import the server module and create runtime SQLite/media paths.
# Never carry those generated paths into the published image.
RUN rm -rf /app/data /app/database

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app /app

USER node
EXPOSE 3000 3001
VOLUME ["/app/data", "/app/database"]

CMD ["npm", "run", "start"]
