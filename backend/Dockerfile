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
ARG MILL_VERSION=1.1.8
RUN curl -fsSL "https://raw.githubusercontent.com/com-lihaoyi/mill/${MILL_VERSION}/mill" -o /usr/local/bin/mill \
    && chmod +x /usr/local/bin/mill

# Mill writes its build output to `out/`. Inside Compose the project directory is bind-mounted from
# the host, and the container runs as root, so without this the container would litter the
# developer's checkout with root-owned files they cannot delete. Pointing Mill at a directory inside
# the container keeps the host tree clean and keeps host and container builds from fighting over the
# same compiled classes.
ENV MILL_OUTPUT_DIR=/mill-out

WORKDIR /app

# Copy only the build definition first and compile an empty project. That downloads Mill itself and
# every third-party library into the image's cache, so a later `docker compose up` starts in
# seconds instead of re-downloading hundreds of megabytes. Docker re-runs this step only when the
# build definition changes, not when a source file does.
COPY .mill-version build.mill ./
RUN mkdir -p src && mill compile

# Now the sources. In Compose these are shadowed by the bind mount, but copying them keeps the
# image useful on its own (`docker run` without a mount still starts a working server).
COPY src ./src
COPY test ./test
COPY resources ./resources

# Defaults matching docker-compose.yml; override them with `environment:` entries there.
ENV MONGO_URI=mongodb://mongo:27017 \
    MONGO_DB=obs_effects \
    HTTP_PORT=8080

EXPOSE 8080

# `--no-daemon` keeps Mill from leaving a background build server behind inside the container: the
# container's whole job is this one process, and a leftover daemon would confuse `docker stop`.
CMD ["mill", "--no-daemon", "run"]
