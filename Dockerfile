# theychat 服务端镜像（设计见 DESIGN.md §6/§8）
# 多阶段：第一阶段构建 web 前台（vite 产物 dist/），第二阶段只带后端运行时
FROM node:20-bookworm-slim AS webbuild

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存（web 构建需要 devDependencies：vite 等）
COPY package.json package-lock.json ./
COPY theychat-backend/package.json theychat-backend/
COPY theychat-cli/package.json theychat-cli/
COPY theychat-web/package.json theychat-web/
RUN npm ci

COPY theychat-web/ theychat-web/
RUN npm run build -w theychat-web

# ---------- 运行时 ----------
FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY theychat-backend/package.json theychat-backend/
COPY theychat-cli/package.json theychat-cli/
COPY theychat-web/package.json theychat-web/
RUN npm ci --omit=dev

COPY theychat-backend/src theychat-backend/src/
COPY --from=webbuild /app/theychat-web/dist theychat-web/dist/

ENV NODE_ENV=production \
    THEYCHAT_FILES_DIR=/data/files \
    THEYCHAT_HOST=0.0.0.0 \
    THEYCHAT_PORT=8000

# 上传临时文件目录
VOLUME /data
EXPOSE 8000

CMD ["node", "theychat-backend/src/server.js"]
