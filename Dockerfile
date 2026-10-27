# Stage 1 compiles the TypeScript sources; stage 2 is the runtime image and
# contains only production dependencies plus the compiled output.
FROM node:22-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ui/package.json ./ui/package.json
RUN pnpm install --frozen-lockfile

# .dockerignore keeps .env, local state and previous build output out
COPY . .
RUN pnpm build && pnpm build:ui


FROM node:22-alpine

WORKDIR /app

# git clones repositories; docker-cli starts build sandboxes; docker-cli-buildx
# gives `docker build` BuildKit (image builds for the node/dockerfile strategies
# need --progress and the <Dockerfile>.dockerignore lookup, which the legacy
# builder lacks); openssh-client deploys to "ssh" and "docker" targets.
RUN apk add --no-cache git docker-cli docker-cli-buildx openssh-client

# Enable pnpm through Corepack
RUN corepack enable

# Copy dependency files first (the dashboard's packages are devDependencies:
# only its built static files ship, below)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY ui/package.json ./ui/package.json

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Static assets the compiled code reads at runtime (schema), the CLI manifest
# (version lookups), and the end-to-end tests that run from this image.
COPY db ./db
COPY cli/package.json ./cli/package.json
COPY test ./test

# Compiled server and CLI output
COPY --from=build /app/dist ./dist
COPY --from=build /app/cli/dist ./cli/dist

# Web dashboard (static files served by the API under /ui)
COPY --from=build /app/ui/dist ./ui/dist

EXPOSE 8000 8080

USER node

CMD ["node", "dist/index.js"]
