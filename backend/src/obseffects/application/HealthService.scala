package obseffects.application

/** What `GET /api/health` reports when everything is fine. */
final case class HealthStatus(effects: Long, routes: Long)

/** Answers "is this service usable right now?".
  *
  * "Usable" means more than "the process is running": without MongoDB the service can serve nothing, so an unreachable
  * database is reported as a failure (500) rather than a cheerful "ok".
  */
class HealthService(datastore: DatastoreHealth, effects: EffectRepository, routes: RouteRepository) {

  def check(): Either[AppError, HealthStatus] =
    if (!datastore.reachable()) Left(AppError.Internal("MongoDB is not reachable", Map("mongo" -> "down")))
    else
      // Counting also proves the database is not merely answering pings but actually serving reads.
      Right(HealthStatus(effects = effects.count(), routes = routes.count()))
}
