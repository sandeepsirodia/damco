# Stage 1: build the React + CopilotKit chat frontend
FROM node:20-alpine AS web-build
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# Stage 2: the Express server, serving the built frontend
FROM node:20-alpine
WORKDIR /app

# repoReader.js shells out to `git clone` for GitHub-URL repo paths.
RUN apk add --no-cache git

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY --from=web-build /web/dist ./web/dist

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
