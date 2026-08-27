package obseffects.infrastructure.http

import obseffects.application.{
  AdminService,
  AppError,
  EffectService,
  HealthService,
  Operator,
  PresetService,
  RouteService,
  SessionService,
  SettingsService,
  SoundService,
  TwitchService
}
import obseffects.infrastructure.http.Wire.{ObsAudioViewDto, TwitchViewDto}
import sttp.capabilities.WebSockets
import sttp.shared.Identity
import sttp.tapir.server.ServerEndpoint
import sttp.tapir.server.netty.sync.OxStreams
import sttp.tapir.swagger.bundle.SwaggerInterpreter

import java.time.format.DateTimeFormatter
import java.time.{Clock, ZoneOffset}

/** Attaches the actual behaviour to the endpoint descriptions from [[Endpoints]].
  *
  * Every handler below is ordinary blocking code that returns `Either[AppError, Result]`. There is no `Future`, no `IO`
  * and no callback anywhere: the netty *sync* backend runs each request on its own Java 21 virtual thread, so blocking
  * on MongoDB is both allowed and cheap. `Identity[A] = A` is Tapir's way of spelling "no wrapper type at all".
  *
  * ==How the security check runs==
  *
  * A protected endpoint is completed in two steps rather than one:
  *
  *   1. `.handleSecurity(requireOperator)` receives the session cookie and answers `Either[AppError, Operator]`. A
  *      `Left` here ends the request with the contract's `401` envelope and the endpoint's own logic never runs.
  *   2. `.handle(operator => input => …)` is the endpoint's logic, which only exists once step 1 has succeeded.
  *
  * The nested shape — a function returning a function — is Tapir's, and it is what makes it impossible to write a
  * protected handler that forgets to check anything: there is nowhere to put the logic except behind the check.
  *
  * The handlers below ignore the `Operator` they are given, because with a single operator there is nothing to
  * personalise. It is still passed rather than dropped so that the day something *is* per-operator — an audit trail,
  * say — the value is already where it needs to be.
  */
class HttpApi(
    effects: EffectService,
    routes: RouteService,
    presets: PresetService,
    admin: AdminService,
    health: HealthService,
    sessions: SessionService,
    routeEvents: RouteEventStream,
    audioLevels: AudioLevelStream,
    settings: SettingsService,
    twitch: TwitchService,
    chatStream: ChatStream,
    sounds: SoundService,
    clock: Clock,
    cookieSecure: Boolean
) {

  /** The `ServerSecurityLogic` every protected endpoint shares: cookie in, operator or `401` out. Written once, here,
    * so no endpoint can accidentally use a different rule.
    */
  private val requireOperator: Option[String] => Either[AppError, Operator] = sessions.authorise

  /** The filename an export is offered under: `obs-effects-export-20260824-101112.json`, in UTC.
    *
    * A timestamp in the name is what stops the fifth backup of the day from being called `obs-effects-export (4).json`
    * in a downloads folder, and sorting by name sorts by age.
    */
  private val ExportFilenameStamp: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneOffset.UTC)

  /** Settings and live connection status in one object.
    *
    * Read together, from the same instant, on purpose: two requests could show a saved URL next to the status of the
    * connection it replaced, which is exactly the moment an operator is trying to work out whether their change took
    * effect.
    */
  private def obsAudioView(): ObsAudioViewDto =
    ObsAudioViewDto(
      settings = Wire.toDto(settings.obsAudio()),
      status = Wire.toDto(settings.obsStatus(), settings.levelSubscribers())
    )

  /** The Twitch settings and live status in one object, read from the same instant — the same reasoning as
    * [[obsAudioView]].
    */
  private def twitchView(): TwitchViewDto =
    TwitchViewDto(
      settings = Wire.toDto(twitch.twitch()),
      status = Wire.toDto(twitch.chatStatus(), twitch.chatSubscribers())
    )

  /** Endpoints anyone may call. The list type names `OxStreams` because one of them — the event stream — needs a server
    * that can write an ox flow; the rest require nothing, and a capability requirement of `Any` fits anywhere.
    */
  private val publicEndpoints: List[ServerEndpoint[OxStreams & WebSockets, Identity]] = List(
    Endpoints.health.handle(_ => health.check().map(Wire.toDto)),
    Endpoints.login.handle { request =>
      sessions.login(request.password).map { outcome =>
        val cookie = outcome.session.map { session =>
          SessionCookie.issue(session.token, sessions.cookieMaxAgeSeconds, cookieSecure)
        }
        (Wire.toDto(outcome.info), cookie)
      }
    },
    Endpoints.logout.handle { rawToken =>
      sessions.logout(rawToken)
      Right(SessionCookie.clear(cookieSecure))
    },
    Endpoints.session.handle(rawToken => Right(Wire.toDto(sessions.describe(rawToken)))),
    // `by-slug` must come before the `{id}` endpoint: they share the `/api/routes/...` prefix, and
    // Tapir tries endpoints in order, so the more specific path has to get the first look. That is
    // also why the two live in different lists but are concatenated in the right order below.
    Endpoints.getRouteBySlug.handle(slug => routes.getBySlug(slug).map(Wire.toDto)),
    // Always a `Right`: this endpoint has no failure mode. A slug with no route is answered with
    // an `absent` event on an open 200 stream, because a browser source may legitimately be
    // pointed at a slug that has not been created yet.
    Endpoints.routeEvents.handle(slug => Right(routeEvents.open(slug))),
    // Also always a `Right`, and for a similar reason: a page asking for audio levels when no OBS
    // connection is configured is not making a mistake, it is asking a question whose answer is
    // "silence". Reporting that as an error would make every audio effect need a failure branch.
    Endpoints.audioLevels.handle(_ => Right(audioLevels.open())),
    // Always a `Right` too: chat not being configured is answered inside the stream — an empty
    // snapshot and a status frame saying why — so an overlay never needs a failure branch either.
    Endpoints.chatWs.handle(_ => Right(chatStream.open())),
    // The only public `/api/sounds/...` route. It cannot collide with the protected list at `/api/sounds` (different
    // segment count) or with the delete at `/api/sounds/{id}` (different method and segment count), so the order
    // relative to those does not matter — but it lives in this list because the OBS browser source that plays it
    // cannot sign in.
    Endpoints.soundAudio.handle { idOrName =>
      sounds.audio(idOrName).map((sound, bytes) => (bytes, sound.contentType))
    }
  )

  private val protectedEndpoints: List[ServerEndpoint[OxStreams & WebSockets, Identity]] = List(
    Endpoints.getObsAudioSettings.handleSecurity(requireOperator).handle(_ => _ => Right(obsAudioView())),
    Endpoints.updateObsAudioSettings
      .handleSecurity(requireOperator)
      .handle(_ => request => settings.saveObsAudio(Wire.toUpdate(request)).map(_ => obsAudioView())),
    Endpoints.getTwitchSettings.handleSecurity(requireOperator).handle(_ => _ => Right(twitchView())),
    Endpoints.updateTwitchSettings
      .handleSecurity(requireOperator)
      .handle(_ => request => twitch.saveTwitch(Wire.toUpdate(request)).map(_ => twitchView())),
    Endpoints.twitchTokens
      .handleSecurity(requireOperator)
      .handle(_ => request => twitch.storeTokens(request.accessToken, request.refreshToken).map(_ => twitchView())),
    Endpoints.twitchOAuthComplete
      .handleSecurity(requireOperator)
      .handle(_ => request => twitch.completeOAuth(request.code, request.redirectUri).map(_ => twitchView())),
    Endpoints.chatHistory
      .handleSecurity(requireOperator)
      .handle(_ => (limit, before, beforeId) => twitch.chatHistory(limit, before, beforeId).map(_.map(Wire.toDto))),
    Endpoints.listEffects.handleSecurity(requireOperator).handle(_ => _ => Right(effects.list().map(Wire.toDto))),
    Endpoints.syncEffects
      .handleSecurity(requireOperator)
      .handle(_ => request => effects.sync(request.effects.map(Wire.toRaw)).map(Wire.toDto)),
    Endpoints.listRoutes.handleSecurity(requireOperator).handle(_ => _ => Right(routes.list().map(Wire.toDto))),
    Endpoints.createRoute
      .handleSecurity(requireOperator)
      .handle { _ => request =>
        routes.create(Wire.toRaw(request)).map { saved =>
          val dto = Wire.toDto(saved)
          (dto, s"/api/routes/${dto.id}")
        }
      },
    Endpoints.getRoute.handleSecurity(requireOperator).handle(_ => id => routes.getById(id).map(Wire.toDto)),
    Endpoints.updateRoute
      .handleSecurity(requireOperator)
      .handle { _ => (id, request) =>
        routes.update(id, Wire.toRaw(request)).map(Wire.toDto)
      },
    Endpoints.deleteRoute.handleSecurity(requireOperator).handle(_ => id => routes.delete(id)),
    Endpoints.listPresets
      .handleSecurity(requireOperator)
      .handle(_ => effectId => Right(presets.list(effectId).map(Wire.toDto))),
    Endpoints.createPreset
      .handleSecurity(requireOperator)
      .handle { _ => request =>
        presets.create(Wire.toRaw(request)).map { saved =>
          val dto = Wire.toDto(saved)
          (dto, s"/api/presets/${dto.id}")
        }
      },
    Endpoints.getPreset.handleSecurity(requireOperator).handle(_ => id => presets.getById(id).map(Wire.toDto)),
    Endpoints.updatePreset
      .handleSecurity(requireOperator)
      .handle { _ => (id, request) =>
        presets.update(id, Wire.toRaw(request)).map(Wire.toDto)
      },
    Endpoints.deletePreset.handleSecurity(requireOperator).handle(_ => id => presets.delete(id)),
    Endpoints.exportAll
      .handleSecurity(requireOperator)
      .handle { _ => _ =>
        val filename = s"obs-effects-export-${ExportFilenameStamp.format(clock.instant())}.json"
        Right((Wire.toDto(admin.exportAll()), s"""attachment; filename="$filename""""))
      },
    Endpoints.importAll
      .handleSecurity(requireOperator)
      .handle(_ => request => admin.importAll(Wire.toRaw(request)).map(Wire.toDto)),
    Endpoints.listSounds
      .handleSecurity(requireOperator)
      .handle(_ => _ => Right(Wire.SoundListDto(sounds.list().map(Wire.toDto)))),
    Endpoints.uploadSound
      .handleSecurity(requireOperator)
      .handle { _ => (name, contentType, bytes) =>
        sounds.upload(name, contentType, bytes).map { saved =>
          val dto = Wire.toDto(saved)
          (dto, s"/api/sounds/${dto.id}")
        }
      },
    Endpoints.deleteSound.handleSecurity(requireOperator).handle(_ => id => sounds.delete(id))
  )

  /** The interactive documentation page at `/docs`, generated from the endpoint descriptions — it cannot drift out of
    * sync with the real API because it is built from the same values.
    */
  private val docsEndpoints: List[ServerEndpoint[OxStreams & WebSockets, Identity]] =
    SwaggerInterpreter().fromEndpoints[Identity](Endpoints.all, "obs-effects backend", "1.0.0")

  /** Everything the HTTP server should serve. */
  val all: List[ServerEndpoint[OxStreams & WebSockets, Identity]] =
    publicEndpoints ++ protectedEndpoints ++ docsEndpoints
}
