# Running obs-effects-v2 locally

This project runs entirely inside Docker. You do **not** need Node, pnpm, Java,
Scala, Mill or MongoDB installed on your own computer. If you can run
`docker compose`, you can run the whole thing.

If you have never used Docker Compose before, read this page top to bottom
once — it explains every term as it comes up.

---

## The vocabulary, in one minute

- **Image** — a frozen snapshot of a filesystem plus a start command. Think of
  it as an installer for a tiny Linux machine.
- **Container** — a running instance of an image. Starting a container is like
  booting that tiny machine. Deleting it throws away anything written inside it
  that was not stored in a volume.
- **Service** — a named entry in `docker-compose.yml` describing *how* to run
  one container (which image, which ports, which files to share).
- **Volume** — storage managed by Docker that lives *outside* any container, so
  it survives restarts and rebuilds. The database files live in one.
- **Bind mount** — a folder from your own machine shared live into a container.
  This is how editing a source file on your laptop instantly affects the code
  running inside the container.
- **Profile** — an optional group of services that only start when you ask for
  them by name.

---

## Prerequisites

Docker Engine with the Compose v2 plugin. Check with:

```bash
docker compose version
```

If that prints a version number, you are ready.

---

## First run, step by step

All commands are run from the **project root** (the directory containing
`docker-compose.yml`), not from this `docker/` directory.

**1. Create your environment file.**

```bash
cp .env.example .env
```

`.env` holds settings such as which ports to use. Every setting already has a
working default, so you can leave the copied file untouched. It is ignored by
git, so your local tweaks never end up in a commit.

**2. Build the images and start everything.**

```bash
make up
```

That is a shortcut for `docker compose up -d --build`:

- `--build` builds the backend and frontend images from their `Dockerfile`s.
- `-d` ("detached") starts the containers in the background and gives you your
  terminal back.

The **first** run is slow — several minutes. Docker downloads a MongoDB image,
a JVM, the Scala compiler and every JavaScript dependency. Later runs reuse
those caches and start in seconds.

**3. Watch the logs until things settle.**

```bash
make logs
```

This streams the output of all services, colour-coded by service name. Press
`Ctrl+C` to stop watching — that stops *watching*, not the containers.

**4. Check that it worked.**

```bash
make ps
```

You should see `mongo`, `backend` and `frontend` as running, with `mongo`
additionally marked healthy.

---

## What each service is and where to find it

### `mongo` — the database

MongoDB 8, holding two collections:

- `effects` — the catalogue of available visual effects and the parameters each
  one accepts.
- `routes` — the mappings you create in the admin UI, each pairing a slug like
  `main-camera` with an effect id and a set of parameter values.

Published on `localhost:27017` purely so you can inspect it with a GUI such as
MongoDB Compass. The backend does not use that host port; it reaches Mongo over
Docker's private network at the hostname `mongo`.

It has a **healthcheck**: Compose repeatedly runs a `ping` command inside the
container and only starts the backend once that succeeds. Without it the
backend could boot before the database is accepting connections and crash.

### `backend` — the API

The Scala 3 HTTP server. Everything it serves lives under `/api`.

- Health check: <http://localhost:8080/api/health>
- Effect catalogue: <http://localhost:8080/api/effects>
- Routes: <http://localhost:8080/api/routes>

A healthy response from the first URL looks like:

```json
{"status":"ok","mongo":"up","effects":6,"routes":3}
```

`./backend` on your machine is bind-mounted into the container, so your editor
changes reach the running code. The Mill and Coursier download caches are baked into the backend image at
build time, and Mill's compiled output lives in the `backend-out` named
volume, which is what makes recompiles fast.

There is a second Mill output volume, `backend-tasks`, used only by the one-off
build commands (`make backend-test`, `make backend-lint`, `make ci-backend`).
Mill permits one build at a time per output directory and this server holds that
lock on `backend-out` for as long as it is up, so those commands would otherwise
wait for it forever. Giving them their own directory lets them run while the
stack is up, and because it is a volume rather than scratch space, each run
still recompiles only what changed.

### `frontend` — admin UI and effect renderer

The Vite dev server running the SolidJS app. It serves two very different
things from the same address:

- **The admin UI** — <http://localhost:3000/admin>. Create routes, pick an
  effect, tune its parameters, enable or disable it.
- **The renderer** — `http://localhost:3000/e/<slug>`. A bare page with a
  transparent background that draws one effect full-screen. This is the page
  OBS loads.

Saving a source file under `frontend/src` updates the browser automatically
(Hot Module Replacement). If it ever stops reacting, restart just that service:

```bash
docker compose restart frontend
```

### `mongo-express` — optional database browser

A small web UI for poking at the database by hand. It is behind the `tools`
profile, so `make up` does **not** start it. Start it on demand:

```bash
make tools
```

Then open <http://localhost:8081>. Stop it again with
`docker compose stop mongo-express`.

---

## Pointing OBS at an effect

The whole point of this project is that you configure OBS **once** and never
touch it again.

1. In the admin UI, create a route and give it a memorable slug, for example
   `main-camera`. Note the slug exactly — lowercase letters, digits and
   hyphens only.
2. In OBS, click **+** under *Sources* and choose **Browser**.
3. Set **URL** to:

   ```
   http://localhost:3000/e/main-camera
   ```

4. Set **Width** and **Height** to match your canvas (commonly `1920` × `1080`).
5. Tick **Shutdown source when not visible** off if you want the effect to keep
   running while hidden; leave it on to save GPU when it is not on screen.
6. Click **OK**.

From now on, changing the effect or its parameters in the admin UI is enough —
the renderer page polls the backend every five seconds, applies new parameter
values in place, and swaps the whole effect if you point the route at a
different one. You never need to edit the OBS source again.

The renderer page has a transparent background, so whatever is layered beneath
the browser source in OBS shows through.

---

## Everyday commands

| Command | What it does |
| --- | --- |
| `make up` | Build if needed, then start everything in the background |
| `make down` | Stop and remove the containers; **keeps** the database |
| `make logs` | Follow the live logs of every service |
| `make ps` | Show what is running and on which ports |
| `make rebuild` | Rebuild images from scratch, ignoring the layer cache |
| `make backend-test` | Run the Scala test suite in a throwaway backend container |
| `make backend-lint` | Check Scala formatting and lint rules; changes nothing |
| `make backend-format` | Rewrite the Scala sources with scalafmt, then apply the scalafix rules |
| `make frontend-install` | Install/refresh npm packages in the frontend container |
| `make frontend-typecheck` | Type-check the frontend with `tsc` |
| `make frontend-lint` | Lint the frontend with ESLint |
| `make frontend-format` | Rewrite the frontend sources with Prettier |
| `make frontend-format-check` | Report what Prettier would rewrite; changes nothing |
| `make ci-backend` | Everything CI runs for the backend: compile, format check, lint, tests |
| `make ci-frontend` | Everything CI runs for the frontend: install, lint, format, typecheck, build |
| `make ci-compose` | Everything CI runs for Docker: is `docker-compose.yml` still valid? |
| `make shell-backend` | Open a shell inside the backend container |
| `make shell-frontend` | Open a shell inside the frontend container |
| `make tools` | Start mongo-express on <http://localhost:8081> |
| `make clean` | Stop everything and **delete all volumes** (erases the database) |

Run `make` with no arguments to print that list from the Makefile itself.

Two different ways of reaching a container are used above, and the difference matters:

- **`docker compose exec`** runs your command *inside the container that is already up*. It is what
  `make frontend-install`, `frontend-typecheck`, `frontend-lint`, `frontend-format` and the two
  `shell-*` targets do, and it needs `make up` to have been run first.
- **`docker compose run --rm`** starts a *new, throwaway* container from the same image, runs one
  command in it and deletes it. It is what the `backend-*` and `ci-*` targets do, so they work
  whether or not the stack is up.

The backend targets have to use the second form. Mill allows one build at a time per output
directory, and the running server holds that lock for as long as the stack is up — so a test or
lint run reaching into the running container would print `Another Mill process ... is running
'run', waiting for it to be done` and never finish. They point `MILL_OUTPUT_DIR` at a second named
volume (`backend-tasks`) to stay out of the server's way while still keeping their own compiled
output between runs.

---

## Resetting the database

`make down` deliberately keeps your data. To start completely fresh:

```bash
make clean
make up
```

`make clean` runs `docker compose down -v`, where `-v` removes the named
volumes — including `obs-effects-v2_mongo-data`. Every route you created is
gone and cannot be recovered, so only do this when you mean it.

To wipe just the routes and keep the effect catalogue, use mongosh instead:

```bash
docker compose exec mongo mongosh obs_effects --eval 'db.routes.deleteMany({})'
```

---

## When something goes wrong

**Port already in use.** Another program on your machine is holding 3000, 8080
or 27017. Edit `.env` and change `FRONTEND_HOST_PORT`, `BACKEND_HOST_PORT` or
`MONGO_HOST_PORT` to a free number, then `make down && make up`. If you change
the backend port, update `VITE_API_BASE` in `.env` to match, because that URL is
used by your browser.

**The admin UI loads but every API call fails.** Check
<http://localhost:8080/api/health> in a browser tab. If that fails too, look at
`docker compose logs backend`. If it succeeds, `VITE_API_BASE` is probably
wrong — it must be an address your *browser* can reach, so `http://localhost:...`,
never `http://backend:8080`.

**Frontend complains about missing packages after you added a dependency.**
The container's `node_modules` lives in a named volume and is not refreshed
automatically. Run `make frontend-install`.

The same thing happens the other way round: if `make frontend-lint` or
`make frontend-format` reports that `eslint` or `prettier` cannot be found, your
container is running with the package set from before those tools were added to
`package.json`. `make frontend-install` fixes it, and `make ci-frontend` avoids
the problem entirely by installing into a throwaway container.

**Backend behaves as if your edits were ignored.** The Scala server does not
hot-reload. Restart it: `docker compose restart backend`.

**Everything is confusing and you want a clean slate.** `make clean`, then
`make rebuild`, then `make up`. This throws away the database as well.
