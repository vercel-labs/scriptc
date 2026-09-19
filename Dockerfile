# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-bookworm-slim AS node-bin

FROM snowstep/llvm:noble AS runner

ENV PATH="/usr/local/bin:/usr/local/lib/node_modules/.bin:${PATH}"

COPY --from=node-bin /usr/local/bin/ /usr/local/bin/
COPY --from=node-bin /usr/local/lib/ /usr/local/lib/

# Snowstep/llvm:noble ships ca-certificates but not git.
# Required for scriptc: nothing extra (npm install scriptc only).
# Optional — only if compiled binaries run inside THIS container
# (e.g. execSync('git fetch ...') from a Node script compiled here):
#   RUN apt-get update \
#    && apt-get install -y --no-install-recommends git \
#    && rm -rf /var/lib/apt/lists/*
RUN npm install -g scriptc

WORKDIR /work

ENTRYPOINT ["scriptc"]
CMD ["--help"]