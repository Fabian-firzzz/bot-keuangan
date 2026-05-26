FROM node:20-slim
RUN apt-get update -y && apt-get install -y openssl ca-certificates
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npx prisma generate
EXPOSE 3005
CMD ["npm", "start"]
