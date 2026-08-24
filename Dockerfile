FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache git

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

EXPOSE 8000

CMD ["pnpm", "dev"]