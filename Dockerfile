FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps

COPY . .

EXPOSE 4000

CMD ["node", "--expose-gc", "--max-old-space-size=1024", "src/index.js"]