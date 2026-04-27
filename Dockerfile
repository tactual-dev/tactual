FROM node:22-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm install @modelcontextprotocol/sdk playwright
RUN npx playwright install chromium --with-deps

COPY dist/ dist/
COPY LICENSE README.md ./

EXPOSE 8787
ENV TRANSPORT=http
ENV PORT=8787
ENV HOST=0.0.0.0

CMD ["node", "dist/mcp/cli.js", "--http"]
