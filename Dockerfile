FROM node:22-alpine

WORKDIR /app

# Git is required by simple-git
RUN apk add --no-cache git

# Enable pnpm through Corepack
RUN corepack enable

# Copy dependency files first
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install ShipFlow dependencies
RUN pnpm install --frozen-lockfile

# Copy application source
COPY . .

EXPOSE 8000

CMD ["pnpm", "dev"]