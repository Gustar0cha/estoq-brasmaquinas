# Etapa de build: instala todas as dependências (incluindo devDependencies,
# necessárias pro Prisma CLI e pro tsc), gera o Prisma Client e compila.
FROM node:20-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Etapa final: só as dependências de produção + o código já compilado.
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
# Build estático do painel web (versionado no repositório) — o servidor o
# serve em /painel. Sem esta linha a imagem final ficaria só com o dist.
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["node", "dist/server.js"]
