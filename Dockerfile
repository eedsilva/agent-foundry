FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json* ./
COPY apps ./apps
COPY packages ./packages
COPY harness ./harness
COPY workflows ./workflows
COPY models ./models
COPY tsconfig*.json vitest.config.ts prettier.config.mjs ./
RUN npm ci
RUN npm run build
EXPOSE 3000 4000
CMD ["npm", "run", "start", "--workspace", "@agent-foundry/api"]
