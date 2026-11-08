# theychat 服务端镜像（设计见 DESIGN.md §6/§8）
FROM node:20-bookworm-slim

WORKDIR /app

# 先拷贝依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json ./
COPY theychat-backend/package.json theychat-backend/
COPY theychat-cli/package.json theychat-cli/
RUN npm ci --omit=dev

COPY theychat-backend/src theychat-backend/src/

ENV NODE_ENV=production \
    THEYCHAT_FILES_DIR=/data/files \
    THEYCHAT_HOST=0.0.0.0 \
    THEYCHAT_PORT=8000

# 上传临时文件目录
VOLUME /data
EXPOSE 8000

CMD ["node", "theychat-backend/src/server.js"]
