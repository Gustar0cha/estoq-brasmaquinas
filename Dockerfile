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

EXPOSE 3000
CMD ["node", "dist/server.js"]
