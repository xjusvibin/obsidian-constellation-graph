FROM node:22-alpine
WORKDIR /service
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.js ./
USER node
EXPOSE 8787
CMD ["node", "index.js"]
