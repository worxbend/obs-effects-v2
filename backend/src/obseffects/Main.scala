package obseffects

import obseffects.application.AuthMode
import obseffects.infrastructure.http.ServerSetup
import sttp.tapir.server.netty.sync.NettySyncServer

/** The entry point: read the configuration, decide how the admin is protected, build the object graph, make sure the
  * database indexes exist, then serve HTTP until the process is stopped.
  *
  * There is no async framework here on purpose. `startAndWait()` blocks this thread, while each incoming request is
  * handled on its own Java 21 *virtual thread* — a thread that is cheap enough to create per request and that costs
  * nothing while blocked on the database.
  */
object Main {

  def main(args: Array[String]): Unit = {
    val _ = args

    val config = AppConfig.load()

    // The first thing that can stop this process, and deliberately the first thing that runs. An
    // admin panel with no password lets anyone who can reach the port rewrite what a live broadcast
    // is showing, so a missing or unreadable ADMIN_PASSWORD_HASH ends the process here rather than
    // producing a server that works and is open. See AppConfig.authMode for the full reasoning.
    val authMode = config.authMode match {
      case Right(mode)       => mode
      case Left(explanation) =>
        System.err.println("Refusing to start: the admin API would not be protected.")
        System.err.println(explanation)
        sys.exit(1)
    }

    val wiring = new Wiring(config, authMode)

    // On shutdown: close the OBS WebSocket and stop its retry thread, then close the MongoDB client, which lets
    // in-flight operations finish and stops the driver complaining about an abrupt disconnect when the container is
    // stopped. Both live in `Wiring.close()`.
    Runtime.getRuntime.addShutdownHook(new Thread(() => wiring.close(), "shutdown"))

    if (!wiring.mongo.waitForDatabaseAndCreateIndexes()) {
      System.err.println(s"Giving up: MongoDB at ${config.mongoUri} never became reachable")
      sys.exit(1)
    }

    // The same start-up phase as the indexes, and deliberately right after them: the database is known to be
    // reachable, and the unique name index the seed relies on now exists. Idempotent — a builtin sound that is
    // already stored is skipped — so restarts and multiple instances are fine.
    wiring.soundService.seedBuiltins()

    println(s"Starting obs-effects backend on port ${config.httpPort}")
    println(s"  MongoDB:       ${config.mongoUri} (database ${config.mongoDatabase})")
    println(s"  API base:      http://localhost:${config.httpPort}/api")
    println(s"  Documentation: http://localhost:${config.httpPort}/docs")
    printAuthBanner(authMode, config)

    // Open the OBS WebSocket connection, if one is configured. Deliberately *after* the database is known to be
    // reachable, because the settings that say where to connect are read from it — and deliberately non-blocking:
    // `reconfigure` hands the work to the supervisor's own thread and returns, so OBS being closed (which is the
    // normal state of a desktop application) delays the HTTP server by nothing at all.
    wiring.settingsService.startObsAudio()

    // Open the Twitch chat connection the same way, for the same reasons — after the database (the settings and the
    // history snapshot both come from it), and without blocking start-up on the internet being reachable.
    wiring.twitchService.startTwitchChat()

    NettySyncServer()
      .options(ServerSetup.options(config.corsAllowedOrigins))
      // 0.0.0.0 means "accept connections on every network interface". Inside a container the
      // default of localhost would only accept connections from within the container itself, so
      // the port published by Docker would appear dead.
      .host("0.0.0.0")
      .port(config.httpPort)
      .addEndpoints(wiring.httpApi.all)
      .startAndWait()
  }

  /** Says, in the log, how this server is protected.
    *
    * The unprotected case shouts. A capitalised block is not decoration: `ADMIN_AUTH_DISABLED=true` is the one way to
    * end up with an open admin panel, it is easy to set for a five-minute experiment and forget, and the log is the
    * only place the server can say so.
    */
  private def printAuthBanner(authMode: AuthMode, config: AppConfig): Unit = authMode match {
    case AuthMode.Required(_) =>
      println(s"  Admin auth:    password required, sessions last ${config.sessionTtlHours}h")
      if (!config.sessionCookieSecure)
        println("                 session cookie is not marked Secure (set SESSION_COOKIE_SECURE=true behind HTTPS)")

    case AuthMode.Disabled =>
      println("")
      println("  ###########################################################################")
      println("  #  ADMIN_AUTH_DISABLED=true — THE ADMIN API IS OPEN TO ANYONE WHO CAN     #")
      println("  #  REACH THIS PORT. Nobody has to sign in to create, edit or delete a     #")
      println("  #  route, which means changing what a live broadcast is showing.          #")
      println("  #  Unset ADMIN_AUTH_DISABLED and set ADMIN_PASSWORD_HASH to close this.   #")
      println("  ###########################################################################")
      println("")
  }
}
