FROM node:24-alpine

WORKDIR /app

# Install Python for argon2 native module
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

CMD ["npm", "start"]
