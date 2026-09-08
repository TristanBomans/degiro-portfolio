FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src

ENV NODE_ENV=production
ENV DEGIRO_PORTFOLIO_PORT=8000
ENV DEGIRO_PORTFOLIO_DB_DIR=/config

VOLUME ["/config"]
EXPOSE 8000

CMD ["npm", "start"]
