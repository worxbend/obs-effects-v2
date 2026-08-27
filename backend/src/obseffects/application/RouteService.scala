package obseffects.application

import obseffects.domain.*

import java.time.Clock

/** The use cases around routes: the create/read/update/delete operations the admin UI drives, plus the slug lookup the
  * effect renderer calls on every load.
  *
  * ==Why this class announces its own writes==
  *
  * Every successful write is followed by a call to [[RouteEventPublisher]], which is what makes the event stream in
  * `GET /api/routes/by-slug/{slug}/events` work. It happens here, in the one place every write already goes through,
  * rather than in the HTTP layer, so that a second caller — the importer, say — cannot forget to do it. The publisher
  * never blocks and never throws, so a browser source that has stopped reading cannot make an admin's Save slow or
  * fail; see `RouteEvents.scala`.
  *
  * @param clock
  *   the source of "now". Injected rather than calling `Instant.now()` inside, so a test can freeze time and assert on
  *   `createdAt` / `updatedAt` exactly.
  */
class RouteService(
    routes: RouteRepository,
    effects: EffectRepository,
    events: RouteEventPublisher,
    clock: Clock
) {

  def list(): List[RouteConfig] = routes.listAll().sortBy(_.slug.value)

  /** Looks a route up by its database id. A malformed id is a client mistake, hence 400 rather than 404:
    * `/api/routes/banana` is not "a route that does not exist", it is a bad request.
    */
  def getById(rawId: String): Either[AppError, RouteConfig] =
    for {
      id <- parseId(rawId)
      route <- routes.findById(id).toRight(notFoundById(rawId))
    } yield route

  /** Looks a route up by slug — the call the OBS browser source makes.
    *
    * A slug that does not even match the slug pattern is reported as 404, not 400: from the browser source's point of
    * view an unusable slug is simply a route that does not exist, and an error status here would turn the OBS layer
    * into an error screen.
    *
    * Disabled routes are returned normally; deciding to draw nothing is the renderer's job.
    */
  def getBySlug(rawSlug: String): Either[AppError, RouteConfig] =
    Slug
      .parse(rawSlug)
      .toOption
      .flatMap(routes.findBySlug)
      .toRight(AppError.NotFound(s"No route with slug '$rawSlug'"))

  /** The same lookup as [[getBySlug]], but phrased as "is there one?" rather than as a possible error.
    *
    * The event stream needs this shape: a slug with no route is a normal state there — the operator may have pointed a
    * browser source at a slug they have not created yet — and turning it into an `AppError` only for the caller to
    * unwrap it again would make "there is nothing here" look like a failure.
    */
  def findBySlug(rawSlug: String): Option[RouteConfig] =
    Slug.parse(rawSlug).toOption.flatMap(routes.findBySlug)

  /** Creates a route. The slug uniqueness check happens twice: once here for a friendly message, and once in MongoDB's
    * unique index, which is what makes two simultaneous creates safe.
    */
  def create(raw: RawRouteInput): Either[AppError, RouteConfig] = {
    val now = clock.instant()
    for {
      input <- validate(raw)
      saved <- routes.insert(input, createdAt = now, updatedAt = now).left.map(writeConflict(input.slug))
    } yield {
      events.routeChanged(saved)
      saved
    }
  }

  /** Replaces a route completely (PUT semantics): any parameter key missing from the body is removed from the stored
    * route.
    *
    * A rename produces *two* events, and this is the one place that rule lives. Anyone still listening on the old slug
    * has to be told that nothing answers to it any more — otherwise an OBS source pointed at the old name would keep
    * drawing what it drew before the rename until somebody reloaded it by hand.
    */
  def update(rawId: String, raw: RawRouteInput): Either[AppError, RouteConfig] =
    for {
      id <- parseId(rawId)
      input <- validate(raw)
      previousSlug = routes.findById(id).map(_.slug)
      replaced <- routes.replace(id, input, clock.instant()).left.map(writeConflict(input.slug))
      saved <- replaced.toRight(notFoundById(rawId))
    } yield {
      previousSlug.filter(_ != saved.slug).foreach(events.routeRemoved)
      events.routeChanged(saved)
      saved
    }

  def delete(rawId: String): Either[AppError, Unit] =
    for {
      id <- parseId(rawId)
      // Read before deleting: the slug is the only thing subscribers know a route by, and after
      // the delete there is nothing left to read it from.
      slug = routes.findById(id).map(_.slug)
      _ <- Either.cond(routes.delete(id), (), notFoundById(rawId))
    } yield slug.foreach(events.routeRemoved)

  def count(): Long = routes.count()

  // -------------------------------------------------------------------------------------------

  /** Runs the domain validation, giving it a way to look effects up, and translates its two failure shapes into the
    * application's error type.
    */
  private def validate(raw: RawRouteInput): Either[AppError, RouteInput] =
    Validation.validateRouteInput(raw, findEffect).left.map {
      case InputError.UnknownEffect(effectId) => AppError.UnknownEffect(effectId)
      case InputError.Invalid(issues)         => AppError.ValidationFailed(issues)
    }

  /** An effect id that does not even match the id pattern cannot be in the inventory, so it is treated the same as one
    * that simply is not there.
    */
  private def findEffect(rawEffectId: String): Option[EffectDescriptor] =
    EffectId.parse(rawEffectId).toOption.flatMap(effects.findById)

  private def parseId(rawId: String): Either[AppError, RouteId] =
    RouteId.parse(rawId).left.map(message => AppError.BadRequest(s"Invalid route id '$rawId': $message"))

  private def notFoundById(rawId: String): AppError = AppError.NotFound(s"No route with id '$rawId'")

  /** The only storage failure a route write can produce is a taken slug. `NameTaken` belongs to presets and cannot
    * reach here, but the compiler asks for the branch, and answering "the slug is taken" would be a lie — so it becomes
    * the internal error it would in fact be.
    */
  private def writeConflict(slug: Slug)(failure: RepositoryFailure): AppError = failure match {
    case RepositoryFailure.SlugTaken => AppError.SlugConflict(slug.value)
    case RepositoryFailure.NameTaken => AppError.internal("A route write reported a preset name conflict")
  }
}
