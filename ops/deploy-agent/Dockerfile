FROM node:22-bookworm-slim

WORKDIR /app
COPY lib.js server.js ./
COPY targets.json /config/targets.json

ENV NODE_ENV=production
ENV PORT=8080
ENV DEPLOY_TARGETS_FILE=/config/targets.json

EXPOSE 8080
CMD ["node", "server.js"]
