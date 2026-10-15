FROM node:22-alpine

WORKDIR /app

# git clones repositories; docker-cli starts build sandboxes; openssh-client
# deploys to "ssh" targets.
RUN apk add --no-cache git docker-cli openssh-client

# Enable pnpm through Corepack
RUN corepack enable

# Copy dependency files first
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy application source (.dockerignore keeps .env and local state out)
COPY . .

EXPOSE 8000 8080

USER node

CMD ["node", "index.js"]
