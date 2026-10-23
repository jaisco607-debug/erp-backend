# Backend image (Node 20). Runs as a normal user, not root.
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# production packages + the migration tool (it is a dev package in package.json, but the server needs it to run db:migrate)
RUN npm ci --omit=dev && npm install --no-save sequelize-cli@6 && npm cache clean --force
COPY . .
RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
