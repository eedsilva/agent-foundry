FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# bubblewrap + socat: Claude Code's own OS-level Bash sandbox (#565) needs
# both on Linux. EXECUTOR_MODE=real fails closed without them
# (sandbox.failIfUnavailable — see docs/adr/0071); the container also needs
# `security_opt: [seccomp:unconfined]` at the docker-compose/runtime level
# for bubblewrap's unprivileged user-namespace creation to work at all
# (verified empirically, docs/adr/0071).
RUN apt-get update && apt-get install -y --no-install-recommends bubblewrap socat \
  && rm -rf /var/lib/apt/lists/*
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
