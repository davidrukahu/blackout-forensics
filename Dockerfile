# SPDX-FileCopyrightText: 2026 David Rukahu
# SPDX-License-Identifier: AGPL-3.0-only

# The Telemetry Control Audit container.
#
# This image runs inside the customer's environment, reads their telemetry, and writes a findings
# bundle plus a contents listing. It makes no network connections: run it with --network none and
# it behaves identically, which is the point.
#
# UNPINNED — must be pinned by digest before this image is offered to any customer. The image a
# security team reviews must be the image they run, and a tag can move underneath both. Resolve
# with: docker inspect --format='{{index .RepoDigests 0}}' node:24-bookworm-slim
FROM node:24-bookworm-slim AS build

WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY scripts ./scripts
RUN npm ci --ignore-scripts
RUN npm run typecheck

FROM node:24-bookworm-slim

LABEL org.opencontainers.image.title="Blackout Forensics — Telemetry Control Audit"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
LABEL org.opencontainers.image.description="Reads telemetry locally and emits an aggregate findings bundle. No network access required or used."

WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages ./packages
COPY --from=build /src/package.json ./package.json

# Never root: the customer's security team should not have to ask.
USER node

# Input is mounted read-only; output is the only writable path the container needs.
VOLUME ["/data", "/out"]

ENTRYPOINT ["node", "packages/audit/dist/cli.js"]
CMD ["--help"]
