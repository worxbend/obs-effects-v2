# Shortcuts for the Docker Compose development stack.
#
# `make` is a very old tool whose only job here is to save you typing. Each
# target below is one command you could also type by hand; the comment above
# it says what it does and when you would want it.
#
# Usage:  make up      /  make logs  /  make down
# List:   make help
#
# Note for anyone editing this file: recipe lines MUST start with a real TAB
# character, not spaces. That is a hard rule of make, not a style choice.

# .PHONY tells make "these are commands, not files to build". Without it, a
# file named e.g. `clean` in this directory would stop `make clean` working.
.PHONY: help up down logs ps rebuild backend-test backend-lint backend-format \
        frontend-install frontend-typecheck frontend-lint frontend-format frontend-format-check \
        new-effect \
        shell-backend shell-frontend tools clean ci-backend ci-frontend ci-compose

# The Node image used by `make ci-frontend`. It is written here once so there is
# a single place to change it, but it must be kept in step with two other files:
# the `FROM` line in frontend/Dockerfile, and `node-version` in the frontend job
# of .github/workflows/ci.yml. All three describe the same Node line.
NODE_IMAGE ?= node:24-bookworm-slim

# The first target is what plain `make` runs, so make it the friendly one.
help: ## Show this list of targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

up: ## Build images if needed and start mongo + backend + frontend in the background
	docker compose up -d --build

down: ## Stop and remove the containers (the database volume is kept)
	docker compose down

logs: ## Follow the live log output of every service (press Ctrl+C to stop watching)
	docker compose logs -f

ps: ## Show which services are running, their state and their published ports
	docker compose ps

rebuild: ## Force a from-scratch image rebuild, ignoring the Docker layer cache
	docker compose build --no-cache

# How the one-off Mill commands below are run, and why it looks like this.
#
# `docker compose run --rm --no-deps backend` starts a *throwaway* container
# from the backend image rather than reaching into the running one:
#
#   run --rm    a fresh container that is deleted the moment the task finishes
#   --no-deps   do not start MongoDB alongside it; none of these tasks touch a
#               database (the tests use in-memory repositories), so waiting for
#               its health check would add half a minute for nothing
#
# MILL_OUTPUT_DIR points at the second named volume declared in
# docker-compose.yml. Mill permits one build at a time per output directory, and
# the running backend server holds that lock on /mill-out for as long as the
# stack is up. Without this override these commands would print "Another Mill
# process ... is running 'run', waiting for it to be done" and hang. With it
# they work whether the stack is up or down, and because it is a volume rather
# than scratch space, the next run still recompiles only what changed.
MILL_TASK = docker compose run --rm --no-deps -e MILL_OUTPUT_DIR=/mill-tasks backend mill --no-daemon

backend-test: ## Run the Scala test suite (MUnit) in a throwaway backend container
	$(MILL_TASK) test

# scalafmt (layout) plus scalafix (unused imports, import order, forbidden
# constructs) over both src/ and test/src/, in check-only mode. It never edits a
# file; `make backend-format` is what rewrites them.
backend-lint: ## Check Scala formatting and lint rules (scalafmt + scalafix), rewriting nothing
	$(MILL_TASK) lint

# The counterpart that does rewrite. `reformatAll` applies scalafmt, `fixAll`
# applies the scalafix rules; running them in that order matches what `lint`
# then checks.
backend-format: ## Rewrite the Scala sources with scalafmt, then apply the scalafix rules
	$(MILL_TASK) reformatAll
	$(MILL_TASK) fixAll

frontend-install: ## Install/refresh npm packages inside the frontend container
	docker compose exec frontend pnpm install

frontend-typecheck: ## Type-check the frontend (tsc) inside the frontend container
	docker compose exec frontend pnpm run typecheck

# The `--max-warnings 0` in the underlying npm script means a rule set to "warn"
# fails this target exactly like an error does.
#
# If this reports that `eslint` cannot be found, your container is running with
# a node_modules from before ESLint was added to package.json — it lives in a
# named Docker volume that is not refreshed on its own. Run `make
# frontend-install` once and try again, or use `make ci-frontend`, which
# installs into a throwaway container and so never has that problem.
frontend-lint: ## Lint the frontend (ESLint) inside the frontend container
	docker compose exec frontend pnpm run lint

frontend-format: ## Rewrite the frontend sources with Prettier inside the frontend container
	docker compose exec frontend pnpm run format

frontend-format-check: ## Report frontend files Prettier would rewrite, changing nothing
	docker compose exec frontend pnpm run format:check

# Scaffolding a new effect.
#
# `frontend/tools/new-effect.mjs` writes a complete, running effect file and registers it in
# `frontend/src/effects/index.ts`. It is plain Node with no dependencies at all, so unlike the
# targets above it needs neither the running stack nor an install: a bare Node image over the
# frontend sources is enough. That is why it uses $(NODE_IMAGE) directly rather than
# `docker compose exec frontend`, and why it works when nothing is up.
#
# Usage (all three variables are required, and NAME is the one that needs quoting):
#
#   make new-effect ID=aurora-ribbon NAME="Aurora Ribbon" ENGINE=three
#
# The `-u $(id -u):$(id -g)` is what stops the generated file being owned by root: the container
# runs as you, so the file it writes into your working tree belongs to you and your editor can save
# over it. Every other container target in this file does the same, for the same reason.
new-effect: ## Scaffold a new effect: make new-effect ID=my-effect NAME="My Effect" ENGINE=three|pixi
	@test -n "$(ID)" -a -n "$(NAME)" -a -n "$(ENGINE)" || { \
		echo 'Usage: make new-effect ID=aurora-ribbon NAME="Aurora Ribbon" ENGINE=three|pixi'; \
		exit 1; \
	}
	docker run --rm \
		-u $$(id -u):$$(id -g) \
		-e HOME=/tmp \
		-v "$(CURDIR)/frontend:/app" -w /app \
		$(NODE_IMAGE) \
		node tools/new-effect.mjs "$(ID)" "$(NAME)" "$(ENGINE)"

shell-backend: ## Open an interactive shell inside the running backend container
	docker compose exec backend bash

shell-frontend: ## Open an interactive shell inside the running frontend container
	docker compose exec frontend sh

tools: ## Start mongo-express, the optional database browser, on http://localhost:8081
	docker compose --profile tools up -d mongo-express

clean: ## Stop everything AND delete all volumes — this erases the database
	docker compose down -v --remove-orphans

# -----------------------------------------------------------------------------
# Reproducing continuous integration on your own machine
#
# .github/workflows/ci.yml runs three checks on every push: the backend gate,
# the frontend gate, and a syntax check of docker-compose.yml. The three targets
# below run those same checks here, so a red build can be understood and fixed
# without pushing a commit and waiting for GitHub to answer.
#
# One deliberate difference: the workflow installs Java and Node directly onto
# the throwaway machine GitHub rents out, because that machine already has them
# and is deleted afterwards. Your machine is not expected to have either, so
# these targets do the same work inside containers. The *commands* being checked
# are identical; only the thing they run inside differs.
# -----------------------------------------------------------------------------

# Four separate container runs, one per Mill task, so that the task that failed
# is obvious from where the output stops. They share the `backend-tasks` volume
# through $(MILL_TASK) above, so each run reuses what the previous one compiled
# and none of them contends with a running backend server for Mill's lock.
ci-backend: ## Reproduce the CI backend gate: compile, format check, lint, tests
	$(MILL_TASK) compile
	$(MILL_TASK) checkFormatAll
	$(MILL_TASK) lint
	$(MILL_TASK) test

# This one deliberately does NOT use the `frontend` service from
# docker-compose.yml. That service keeps its node_modules in a named Docker
# volume that is only written when the image is built, so a stack left running
# since before a dependency changed would check the wrong set of packages — and
# so disagree with CI, which is the one thing this target exists to prevent.
#
# Instead: a throwaway container over the frontend sources, installing exactly
# what pnpm-lock.yaml pins, which is what the workflow does.
#
#   -u $(id -u):$(id -g)  run as you, so anything written into frontend/
#                         (node_modules/, dist/) belongs to you, not to root
#   -e HOME=/tmp          a writable home directory; Corepack downloads pnpm
#                         into it, and pnpm keeps its package store there
#   -e CI=1               what package managers and test tools read to decide
#                         they are not talking to a human
#   sh -e -c              -e means "stop at the first command that fails", so a
#                         failing lint run does not go on to the build
#   corepack pnpm ...     runs the pnpm version pinned by the `packageManager`
#                         field of package.json. `corepack pnpm` is used rather
#                         than `corepack enable` + `pnpm` because enabling
#                         writes into /usr/local/bin, which the unprivileged
#                         user above is not allowed to do. The CI workflow, not
#                         being under that restriction, uses `corepack enable`.

# The five checks, in the order CI runs them, as one shell script. They are
# separated by `;` rather than `&&` because `sh -e` above already stops at the
# first failure, and a plain list is easier to read and to add a step to. Make
# joins the backslash-continued lines below into a single line before the
# recipe uses it.
CI_FRONTEND_SCRIPT = corepack pnpm install --frozen-lockfile; \
                     corepack pnpm run lint; \
                     corepack pnpm run format:check; \
                     corepack pnpm run typecheck; \
                     corepack pnpm run build

ci-frontend: ## Reproduce the CI frontend gate: install, lint, format check, typecheck, build
	docker run --rm \
		-u $$(id -u):$$(id -g) \
		-e HOME=/tmp -e CI=1 -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
		-v "$(CURDIR)/frontend:/app" -w /app \
		$(NODE_IMAGE) \
		sh -e -c '$(CI_FRONTEND_SCRIPT)'

# Parses the file, fills in every ${VARIABLE:-default} substitution, and
# validates the result against the Compose specification. `--quiet` prints
# nothing and reports through the exit status alone. Nothing is started and no
# image is pulled.
ci-compose: ## Reproduce the CI compose check: is docker-compose.yml still valid?
	docker compose config --quiet
