# obs-effects backend

The admin service behind obs-effects. It stores two things in MongoDB — the **effect inventory**
(what visual effects the frontend can draw) and the **routes** (a slug such as `main-camera` mapped
to one effect plus its parameter values) — and serves them over a small JSON API.

`docs/CONTRACT.md` at the repository root is the authoritative description of that API. If this
README and the contract ever disagree, the contract wins.

Written in Scala 3 in **direct style**: plain, blocking, top-to-bottom code running on Java 21
virtual threads. There is no `Future`, no cats-effect, no ZIO and no callback anywhere in the
codebase, which means you can read any function from top to bottom and it does exactly what it says.

---

## Running it

Nothing needs to be installed on your machine except Docker. From the repository root:

```bash
docker compose up backend
```

That starts MongoDB and this service. Once it is up:

- API base: <http://localhost:8080/api>
- Health check: <http://localhost:8080/api/health>
- Interactive API documentation (Swagger UI): <http://localhost:8080/docs>

The service waits for MongoDB to accept connections before it starts serving, so it does not matter
which container becomes ready first.

### Working inside the container

The `backend/` directory is bind-mounted into the container at `/app`, so an edit on your machine is
immediately visible inside it. To pick up a change, restart the service:

```bash
docker compose restart backend
```

To run a build command by hand:

```bash
MILL='docker compose run --rm --no-deps -e MILL_OUTPUT_DIR=/mill-tasks backend mill --no-daemon'

$MILL compile                                     # compile
$MILL test                                        # run all tests
$MILL test.testOnly obseffects.domain.ValidationSuite   # run one suite
$MILL lint                                        # check formatting and lint rules
$MILL reformatAll                                 # rewrite files with scalafmt
```

`make backend-test`, `make backend-lint` and `make backend-format` are shorthand for the common
ones. Three details in that command line are worth understanding rather than copying:

- **`run --rm --no-deps`** starts a throwaway container instead of reaching into the running one,
  and does not drag MongoDB up alongside it. None of these tasks touch a database.
- **`MILL_OUTPUT_DIR=/mill-tasks`** points Mill at a second output directory. Mill permits one
  build at a time per output directory, and the backend service's own `mill run` holds the lock on
  the default `/mill-out` for as long as the stack is up. Without the override these commands
  print `Another Mill process ... is running 'run', waiting for it to be done` and wait forever.
- **`--no-daemon`** stops Mill leaving a background build server behind in a container that is
  about to be deleted anyway.

To start the server by hand instead, leave both overrides off and let it use the normal output
directory: `docker compose run --rm backend mill run`.

### If you do have a JDK on your machine

The `./mill` script in this directory downloads the exact Mill version pinned in `.mill-version`, so
a local JDK 21 is the only prerequisite:

| Command                              | What it does                                                 |
|--------------------------------------|--------------------------------------------------------------|
| `./mill compile`                     | compile the main sources                                     |
| `./mill test`                        | compile and run every MUnit suite                            |
| `./mill test 'obseffects.domain.*'`  | run only the tests whose full name matches the pattern        |
| `./mill test.testOnly <SuiteClass>`  | run one suite, selected by its class name                    |
| `./mill run`                         | start the server (needs a reachable MongoDB)                 |
| `./mill assembly`                    | build one self-contained jar in `out/assembly.dest/out.jar`  |
| `./mill lint`                        | check formatting **and** lint rules; changes nothing         |
| `./mill checkFormatAll`              | check formatting only; changes nothing                       |
| `./mill reformatAll`                 | rewrite every Scala file into the house format               |
| `./mill fixAll`                      | apply the scalafix rules, rewriting files in place           |
| `./mill clean`                       | delete `out/` and start from scratch                         |

The four formatting and linting commands are explained in
[Code style](#code-style) below.

Point it at a database with environment variables, e.g.
`MONGO_URI=mongodb://localhost:27017 ./mill run`.

---

## Configuration

Every setting comes from an environment variable. All but one have a default that matches
`docker-compose.yml`; the exception is `ADMIN_PASSWORD_HASH`, which has no safe default and which
the service refuses to start without.

| Variable                | Default                 | Meaning                                                     |
|-------------------------|-------------------------|-------------------------------------------------------------|
| `MONGO_URI`             | `mongodb://mongo:27017` | MongoDB connection string                                    |
| `MONGO_DB`              | `obs_effects`           | Database name inside that server                             |
| `HTTP_PORT`             | `8080`                  | Port the HTTP server listens on                              |
| `ADMIN_PASSWORD_HASH`   | *(unset — required)*    | bcrypt hash of the admin password                            |
| `ADMIN_AUTH_DISABLED`   | `false`                 | `true` runs with no authentication at all                    |
| `SESSION_TTL_HOURS`     | `168` (7 days)          | Session lifetime, and the cookie's `Max-Age`                 |
| `SESSION_COOKIE_SECURE` | `false`                 | `true` adds `Secure` to the session cookie                   |
| `CORS_ALLOWED_ORIGINS`  | *(unset)*               | Exact origins allowed to send credentialed cross-origin calls |

---

## Signing in

The model is **one operator, one password**. There is no user table, no registration and no roles:
this is your own streaming rig, and every one of those would be complexity nobody pays back. You put
a *hash* of your password in `ADMIN_PASSWORD_HASH`, sign in once from the admin UI, and the browser
holds a session cookie from then on.

### Generating the hash

The service never sees your password, only a bcrypt hash of it. Two ways to produce one; either
output works, and neither puts the password in your shell history.

**With the tool in this project** — it asks for the password twice, without echoing it, and prints
the hash:

```bash
docker compose run --rm --no-deps -e MILL_OUTPUT_DIR=/mill-tasks backend \
  mill --no-daemon runMain obseffects.tools.HashPassword
```

**With Apache's `htpasswd`**, from a throwaway container, if you would rather not compile anything.
It also prompts twice; the `cut` at the end drops the empty user name that `htpasswd` prefixes:

```bash
docker run --rm -it httpd:2.4-alpine sh -c 'htpasswd -nBC 12 "" | cut -d: -f2'
```

Two details of that command line are load-bearing, and both were got wrong here once:

- **The `| cut` is inside the quotes, so it runs inside the container.** `-t` gives the container a
  terminal and merges everything the container writes onto it, so a pipe placed *outside* — `docker
  run -it … | cut` — captures the `New password:` prompt as well and the operator types at a blank
  screen. With the pipe inside, the prompt still reaches the terminal on stderr and only the hash
  goes through `cut`.
- **There is no `tail -1`.** `htpasswd` prints the record and then a blank line, so `tail -1`
  selects the blank line and the whole pipeline produces an empty string — with exit status 0, so
  nothing announces the problem until the backend refuses to start.

Either way you get a 60-character line: `$2a$12$…` from the tool in this project, `$2y$12$…` from
`htpasswd`. The four-character marker at the front names the bcrypt variant, and the server accepts
all of them. Put the line in the `.env` file at the repository root:

```dotenv
ADMIN_PASSWORD_HASH='$2a$12$2h3gVA3RDOKk.w0JyGGIo.1GyWjyI3865twAQd3WZxu/DhrUHqK9K'
```

**The single quotes are not optional.** A bcrypt hash is full of `$`, which both a shell and Docker
Compose read as the start of a variable name; without quotes, most of the hash is replaced by
nothing. If a login is refused and you are sure of the password, check what actually arrived before
concluding anything else:

```bash
docker compose exec backend printenv ADMIN_PASSWORD_HASH
```

The `12` in the `htpasswd` command, which the project's own tool uses as its built-in default, is
bcrypt's *cost factor*: a base-2 logarithm, so 12 means 4096 rounds and roughly a quarter of a second
per attempt. That slowness is the point — it is what makes guessing passwords in bulk impractical.

A password longer than 72 bytes is cut to 72 bytes before hashing, here and in every other bcrypt
implementation, so only its first 72 bytes ever matter. That is far more than anybody types, and it
is what lets a hash made with one tool be checked by another.

### What happens when the hash is missing

**The service refuses to start**, prints an explanation naming the variable, and exits with status
1. Starting anyway with a warning was considered and rejected: `docker compose up -d` prints no logs
at all, so a warning is read by nobody, and what it guards is an admin panel that lets anyone who can
reach the port rewrite what a live broadcast is showing. It also refuses to start when the variable
is set to something that is not a readable bcrypt hash, which turns one clear start-up failure into
what would otherwise be an unexplained `500` on every login attempt.

If you genuinely want an unprotected admin — a throwaway experiment on a machine nobody else can
reach — say so explicitly with `ADMIN_AUTH_DISABLED=true`. The service then starts with a capitalised
banner in the log saying the admin is open, and `GET /api/auth/session` answers
`{"authenticated": true, "authRequired": false}` so the UI hides its sign-out control.

### Which endpoints need a session

Everything under `/api` **except** this list, which is exhaustive and matches `docs/CONTRACT.md` §4:

| Public endpoint | Why it cannot be protected |
|---|---|
| `GET /api/health` | Monitoring and the compose health check call it before anyone has signed in. |
| `POST /api/auth/login` | You cannot sign in if signing in requires being signed in. |
| `POST /api/auth/logout` | Idempotent, carries no data, must work when the session already expired. |
| `GET /api/auth/session` | The login page asks it whether to show a form at all. |
| `GET /api/routes/by-slug/{slug}` | An OBS browser source cannot log in. It opens one URL forever, unattended. |
| `GET /api/routes/by-slug/{slug}/events` | The push version of the same read, for the same reason. |
| `GET /docs` | The generated documentation. It describes shapes, not data. |

A new endpoint is **protected by default**. Making one public means adding a row to that table in
the contract with the reason it cannot be protected.

You can see which is which by reading `infrastructure/http/Endpoints.scala`: a public endpoint is
built from `base` and a protected one from `secureBase`, which adds the session cookie as a Tapir
`securityIn`. That is why the split lives in the descriptions rather than in a check inside each
handler — it is meant to be countable by eye.

### Sessions

The cookie is `obs_effects_session`: 32 bytes from `java.security.SecureRandom`, Base64url-encoded,
carrying no information at all. Sessions live in a map inside the backend process — there is no
`sessions` collection in MongoDB and nothing to find in mongo-express. A session ends when you log
out, when it expires, or when the backend restarts.

Changing `ADMIN_PASSWORD_HASH` does **not** end sessions that already exist; the new hash applies to
the next login. A password change meant to lock somebody out has to be followed by
`docker compose restart backend`.

---

## How the code is organised

The project follows **clean architecture**: the important rule is that dependencies only ever point
*inwards*. The domain knows nothing about the outside world, the application layer knows only the
domain, and the infrastructure layer knows everything. You can delete MongoDB and Tapir from this
project without touching a single line in `domain/`.

```
src/obseffects/
├── domain/                     the business rules — no framework imports at all
│   ├── Auth.scala              password hashes, password checking, session tokens
│   ├── Ids.scala               Slug, EffectId, RouteId, ParamKey: opaque types with format rules
│   ├── JsonValue.scala         a library-independent "any JSON value" type
│   ├── Models.scala            EffectDescriptor, RouteConfig, CanvasSettings, and the raw shapes
│   └── Validation.scala        every rule from section 5 of the contract
├── application/                use cases, written against interfaces it defines itself
│   ├── Errors.scala            AppError: the closed set of things that can go wrong
│   ├── Repositories.scala      EffectRepository / RouteRepository / PresetRepository interfaces
│   ├── Sessions.scala          Session, the SessionStore port, its in-memory implementation
│   ├── SessionService.scala    sign in, sign out, authorise, and the login lockout
│   ├── EffectService.scala     list the inventory, replace it from the frontend's manifest
│   ├── RouteEvents.scala       the in-process registry of open event streams
│   ├── RouteService.scala      create / read / update / delete routes, and announce every write
│   ├── PresetService.scala     create / read / update / delete presets
│   ├── AdminService.scala      export everything to one file, and read one back
│   └── HealthService.scala     the health check
├── infrastructure/             everything that talks to the outside world
│   ├── json/JsonValueCodec.scala   circe Json <-> domain JsonValue
│   ├── mongo/                      the synchronous MongoDB driver
│   │   ├── MongoConnection.scala        connection, index creation, startup wait
│   │   ├── BsonCodecs.scala             domain <-> BSON documents, written by hand
│   │   ├── MongoEffectRepository.scala
│   │   ├── MongoRouteRepository.scala
│   │   └── MongoPresetRepository.scala
│   └── http/                       Tapir + netty
│       ├── Wire.scala               the JSON shapes and their circe codecs
│       ├── Endpoints.scala          endpoint *descriptions*, public and protected
│       ├── HttpApi.scala            the logic, attached to those descriptions
│       ├── RouteEventStream.scala   the Server-Sent Events body for one slug
│       ├── SessionCookie.scala      how a session becomes a Set-Cookie header
│       ├── ErrorMapping.scala       AppError <-> status code + error envelope
│       └── ServerSetup.scala        CORS and the fallback error handlers
├── tools/HashPassword.scala    the command-line helper that produces ADMIN_PASSWORD_HASH
├── Config.scala                environment variables in, AppConfig out
├── Wiring.scala                the object graph, built at compile time by macwire
└── Main.scala                  the entry point
```

### Some decisions worth knowing about

**Why "raw" models?** The contract distinguishes *malformed* requests (400) from *well-formed but
invalid* ones (422). If the JSON decoder rejected a bad slug we could only ever answer 400, so
decoding stops at a permissive shape (`RawRouteInput`, `RawEffectDescriptor` — every constrained
field is a plain `String`) and `Validation` turns those into real domain values or a list of
issues.

**Why opaque types for ids?** `Slug`, `EffectId`, `RouteId` and `ParamKey` are all strings at
runtime but different types at compile time, so you cannot pass an effect id where a slug is
expected. Each is built through a `parse` method that enforces its format, which means a value of
type `Slug` is always a valid slug.

**Why is the clock injected?** `RouteService` takes a `java.time.Clock` instead of calling
`Instant.now()` internally. That is what lets `RouteServiceSuite` freeze time and assert on
`createdAt` and `updatedAt` exactly.

**How is slug uniqueness guaranteed?** Twice over. `RouteService` checks first so the error message
is friendly, and MongoDB's unique index `routes_slug_uniq` catches the case where two requests race:
the loser's write fails with a duplicate-key error, which `MongoRouteRepository` converts into
`RepositoryFailure.SlugTaken` and the service reports as **409**.

**How is a preset name kept unique per effect?** By the database alone, and on purpose. The index
`presets_effect_name_uniq` is on the pair `{ effectId, name }` with collation strength 2, which is
MongoDB's way of saying "compare letters and accents, ignore case" — so `Neon` and `neon` collide
for one effect while two different effects may each own a `Default`. Doing the comparison in the
index rather than in the application means no second, lower-cased copy of the name has to be stored
and kept in step, and two simultaneous creates cannot both win. The one thing to remember is that a
query which does not repeat that collation will not use the index, which is why
`MongoPresetRepository.findByEffectAndName` names it explicitly and why sorting is done in
`PresetService`.

**How does a browser source hear about a change within a second?** `GET
/api/routes/by-slug/{slug}/events` is a Server-Sent Events stream — one HTTP response that stays
open while the server writes short blocks of text down it. `RouteService` announces every
successful write to `RouteEventBus` (`application/RouteEvents.scala`), an in-process registry of
whoever is currently listening; `infrastructure/http/RouteEventStream.scala` turns that into the
text an `EventSource` in the browser reads. Two properties are worth knowing because they are the
ones that go wrong quietly:

- *A slow client never slows a writer.* Each listener has a queue of eight events, and a publish
  that finds it full discards the **oldest** waiting event rather than waiting for space. Every
  `config` event carries the whole route and supersedes the one before it, so a browser source that
  stalls and recovers still ends up holding the current state.
- *A disconnected client is deregistered.* The streaming loop blocks on its queue on a virtual
  thread; when the client goes away Tapir cancels that fork, the interrupt unwinds the loop, and a
  `finally` removes the listener. A browser source reconnects for hours, so one leaked queue per
  reconnection would eventually be every queue.

It is deliberately in-process: two backend instances would each notify only their own listeners. A
message broker would fix that and would be a second thing to install, run and monitor for an admin
tool that one person uses.

**Why is an import checked completely before anything is written?** The compose stack runs a
standalone `mongod`, and MongoDB's multi-document transactions need a replica set, so
`POST /api/admin/import` **cannot** be rolled back once it has started writing. `AdminService`
therefore validates every route and every preset in the file first, reports all the problems
together in one `422`, and only then writes. A file with one bad value changes nothing. What that
does not cover is the process dying mid-write; re-running the same import repairs it, because for a
given file both modes are idempotent.

**Where do errors become HTTP?** Only in `ErrorMapping.scala`. Services return
`Either[AppError, A]`; the endpoint descriptions carry the mapping from `AppError` to a status code
and the `{"error": {...}}` envelope. Failures that never reach our code — malformed JSON, an
unmatched path, an unexpected exception — are given the same envelope by `ServerSetup.scala`, so
*every* non-2xx response in this API has one shape.

---

## Tests

```bash
./mill test              # or: docker compose run --rm backend mill test
```

There are four groups, and **none of them needs a running MongoDB**:

- `test/src/obseffects/domain/` — the rules of the domain with nothing else attached.
  `ValidationSuite` covers the contract's validation rules (slug and id formats, parameter types and
  ranges, unknown parameter keys, duplicate effect ids, and the canvas ranges from both sides of
  every boundary); `AuthSuite` covers reading a bcrypt hash, checking a password against it, and
  minting and comparing session tokens.
- `test/src/obseffects/application/*Suite.scala` — the use cases, run against
  `InMemoryRepositories.scala`, which are hand-written stand-ins for the MongoDB repositories that
  reproduce the behaviour the services rely on (including slug uniqueness). `SessionServiceSuite`
  drives the whole sign-in story against a clock the test moves by hand, so a seven-day session can
  be watched expiring in a millisecond.
  `RouteEventsSuite` covers the event registry on its own — a listener is registered and later
  forgotten, an event reaches only its own slug, a full queue drops its oldest entry, and five
  hundred publishes into a queue nobody is reading finish in well under a second.
  `AdminServiceSuite` covers export and import, including the property the whole design exists for:
  a file with one bad record leaves the database exactly as it was.
- `test/src/obseffects/infrastructure/http/WireSuite.scala` — the exact JSON the API emits: field
  names, the timestamp format, omitted optional fields, the one field that is deliberately sent as
  `null`, the error envelope, and the session cookie's attributes.
- `test/src/obseffects/infrastructure/mongo/BsonCodecsSuite.scala` — what the `routes` and `presets`
  collections hold, and what happens when a route document was written before a field existed.
  `org.bson.Document` is an in-memory map, so this needs no server.
- `test/src/obseffects/ConfigSuite.scala` — how environment variables become configuration, including
  the rule that a missing `ADMIN_PASSWORD_HASH` stops the service starting.

The MongoDB repositories themselves are covered by running the service for real; if you want to add
automated coverage for them later, the natural tool is Testcontainers, which starts a throwaway
MongoDB in Docker.

---

## Code style

Scala 3 with **braces**, not significant indentation. The compiler enforces this via `-no-indent`
in `build.mill`, so a stray indentation-style block will not compile.

Beyond that, two separate tools keep the code consistent. They are easy to confuse, so it is worth
being clear about which does what.

| Tool | Config file | What it decides | Can it change what the code *does*? |
|---|---|---|---|
| [scalafmt](https://scalameta.org/scalafmt/) | `.scalafmt.conf` | layout: line width, where line breaks go, the order of selectors inside one import | no, never |
| [scalafix](https://scalacenter.github.io/scalafix/) | `.scalafix.conf` | content: unused imports get deleted, import statements get regrouped, a few risky constructs are refused | yes |

Neither tool needs to be installed. Mill downloads the exact versions pinned in those two config
files the first time you run one of the commands below.

### The four commands

If you only remember one, remember `lint` — it is the one that fails a pull request.

```bash
./mill lint             # check both, write nothing. This is what CI runs.
./mill checkFormatAll   # check layout only, write nothing
./mill reformatAll      # fix the layout, rewriting files
./mill fixAll           # apply the scalafix rules, rewriting files
```

Inside Docker, prefix them the same way as any other build command — including the
`MILL_OUTPUT_DIR` override explained above, so they do not wait on a running backend server:

```bash
docker compose run --rm --no-deps -e MILL_OUTPUT_DIR=/mill-tasks backend mill --no-daemon lint
```

From the repository root, `make backend-lint` is that exact command and `make backend-format` runs
`reformatAll` then `fixAll`.

`lint` reports every problem it finds and exits non-zero without touching a single file, so it is
safe to run against a checkout you are in the middle of editing. When it fails, running
`reformatAll` and then `fixAll` fixes the mechanical part; anything left over is a real complaint
that needs a human.

Each of those four covers **both** the main sources under `src/` and the tests under `test/src/`.
Mill also generates a per-module task for each tool — `reformat`, `checkFormat`, `fix` on the main
module, and `test.reformat`, `test.checkFormat`, `test.fix` on the test module — but those only see
their own half of the tree, which is why the combined commands exist.

### What the rules actually say

`.scalafmt.conf`: 120 columns, Scala 3 dialect, Scaladoc comments wrapped, no trailing commas. The
column limit was chosen to match code that already existed rather than the other way round, so
switching the formatter on reflowed nothing.

`.scalafix.conf` enables three rules:

- **`DisableSyntax`** refuses a short list of constructs. Three are switched on here: `return`
  (inside a lambda it unwinds the enclosing method, which surprises almost everyone), `finalize`
  (deprecated since Java 9, and its timing is undefined) and literal tab characters (they would
  fight the formatter, which indents with spaces). The entries set to `false` in that file are
  deliberate permissions — `var`, `null` and `throw` all have a justified use in the MongoDB layer,
  and the file says where.
- **`OrganizeImports`** puts import statements in one order: everything else first, then a blank
  line, then `java.`/`javax.`, then `scala.`.
- **`RemoveUnused`** deletes imports and private or local definitions that nothing refers to.

`RemoveUnused` is a *semantic* rule: it does not analyse the source text, it reads the warnings the
compiler already produced. Two things make that work, and breaking either one makes the rule go
quiet without failing:

1. `-Wunused:all` in `build.mill`'s `scalacOptions`, which is what produces the warnings.
2. Mill recompiling the sources with **SemanticDB** — an index of what every name in the file
   refers to — before handing them to scalafix. Mill does that automatically; there is nothing to
   configure, but it is why `./mill lint` compiles the project as part of its work.

One trap worth knowing about: scalafix **ignores a setting whose name it does not recognise**,
without complaining. A misspelled option looks switched on and does nothing. If you add one, set it
to the value you do *not* want first and confirm the run fails.

### Where scalafix support comes from

Mill has scalafmt support built in. It has no built-in scalafix support, so `build.mill` pulls in
the [`mill-scalafix`](https://github.com/joan38/mill-scalafix) plugin in the `//|` header block at
the very top of the file. That header is Mill's way of adding libraries to the *build definition*
itself, which is a different classpath from the `mvnDeps` list that the application uses.
