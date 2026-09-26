# Development image for the obs-effects backend.
#
# The idea: nobody installs Java, Mill or Scala on their own machine. This image has all of them,
# and Docker Compose bind-mounts `backend/` into /app, so editing a file on the host and restarting
# the container is enough to run the new code.
#
# It is deliberately a *development* image — it compiles from source on start-up rather than baking
# a jar in. For a production image you would add a second stage running `mill assembly` and copy
# `out/assembly.dest/out.jar` into a slim JRE image.

FROM eclipse-temurin:21-jdk

# `curl` is needed by the Mill launcher script to download Mill itself; `ca-certificates` lets it
# verify the HTTPS connection while doing so.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The launcher is a small shell script; it downloads the Mill version named in `.mill-version`.
# `ADD` fetches it over HTTPS itself (no shell, no curl flags to get wrong) and `--chmod` makes it
# executable in the same step.
ARG MILL_VERSION=1.1.8
ADD --chmod=755 https://raw.githubusercontent.com/com-lihaoyi/mill/${MILL_VERSION}/mill /usr/local/bin/mill

# The container runs as an unprivileged user rather than root. Its uid defaults to 1000, the usual
# uid of the first account on a Linux desktop, so files it writes into the bind-mounted checkout
# (`make backend-format`, for one) belong to the developer. Build with `--build-arg APP_UID=...`
# when yours differs. The base image ships an `ubuntu` account holding uid 1000; it is removed so
# the uid is free for ours.
ARG APP_UID=1000
ARG APP_GID=1000
RUN (userdel --remove ubuntu 2>/dev/null || true) \
    && (groupdel ubuntu 2>/dev/null || true) \
    && groupadd --gid "${APP_GID}" app \
    && useradd --uid "${APP_UID}" --gid app --create-home --shell /bin/bash app \
    && mkdir -p /app /mill-out /mill-tasks \
    && chown app:app /app /mill-out /mill-tasks

# Mill writes its build output to `out/`. Inside Compose the project directory is bind-mounted from
# the host, so pointing Mill at a directory inside the container keeps build output out of the
# developer's checkout and keeps host and container builds from fighting over the same compiled
# classes. /mill-out and /mill-tasks (the output directory the one-off `make` tasks use) are created
# above, owned by `app`: Docker seeds a fresh named volume from the image directory it is mounted
# over, ownership included, so the volumes in docker-compose.yml start out writable by that user.
ENV MILL_OUTPUT_DIR=/mill-out

USER app

# Mill itself and the Coursier library cache land under /home/app/.cache from here on, which the
# unprivileged user owns.
WORKDIR /app

# Copy only the build definition first and compile an empty project. That downloads Mill itself and
# every third-party library into the image's cache, so a later `docker compose up` starts in
# seconds instead of re-downloading hundreds of megabytes. Docker re-runs this step only when the
# build definition changes, not when a source file does.
COPY --chown=app:app .mill-version build.mill ./
RUN mkdir -p src && mill compile

# Now the sources. In Compose these are shadowed by the bind mount, but copying them keeps the
# image useful on its own (`docker run` without a mount still starts a working server).
COPY --chown=app:app src ./src
COPY --chown=app:app test ./test
COPY --chown=app:app resources ./resources

# Defaults matching docker-compose.yml; override them with `environment:` entries there.
ENV MONGO_URI=mongodb://mongo:27017 \
    MONGO_DB=obs_effects \
    HTTP_PORT=8080

EXPOSE 8080

# `--no-daemon` keeps Mill from leaving a background build server behind inside the container: the
# container's whole job is this one process, and a leftover daemon would confuse `docker stop`.
CMD ["mill", "--no-daemon", "run"]
