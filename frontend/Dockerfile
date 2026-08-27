# Frontend image: the Vite dev server with hot module replacement.
#
# Nobody on this project runs Node or pnpm on their own machine — everything happens through
# `docker compose`. This image therefore has one job: install the dependencies and run `vite`
# in a way that survives the source directory being bind-mounted from the host.

# Node 24 is the current Long Term Support ("LTS") line: it gets security fixes for years, which is
# what you want for a base image. "bookworm-slim" is a small Debian base — smaller than the default
# image, but with a real shell and package manager, unlike Alpine, whose different C library
# occasionally trips up native build tools.
#
# The version matters here rather than being a detail: Vite 8 requires Node 20.19+ or 22.12+, and
# the "@types/node" package pinned in package.json describes the APIs of *this* Node line, so the
# two are bumped together.
FROM node:24-bookworm-slim

# Corepack ships inside Node and is the supported way to get a pinned pnpm without a global
# install. The version comes from the "packageManager" field in package.json.
RUN corepack enable

# Where node looks for modules is resolved by walking up the directory tree. Installing into
# /app means /app/node_modules is found from anywhere under /app.
WORKDIR /app

# Copy only the dependency manifests first.
#
# Docker caches each build step. If the manifests have not changed, the (slow) install step below
# is reused from cache even when application source has changed — which is nearly every rebuild.
COPY package.json pnpm-lock.yaml* ./

# --prefer-offline reuses the pnpm store when it is warm.
# --no-frozen-lockfile lets the first ever build succeed before a lockfile has been committed;
# once pnpm-lock.yaml exists it is respected as usual.
RUN pnpm install --prefer-offline --no-frozen-lockfile

# Copy the rest of the application. In development docker-compose bind-mounts the host's source
# over this, so these files mostly matter for a standalone `docker build`.
COPY . .

# Vite's dev server port. Publishing it is done in docker-compose.yml, not here.
EXPOSE 3000

# --host 0.0.0.0 makes the server listen on every interface. Without it, it would bind to
# 127.0.0.1 *inside the container*, which nothing outside the container can reach.
CMD ["pnpm", "run", "dev", "--host", "0.0.0.0", "--port", "3000"]
