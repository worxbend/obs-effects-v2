package obseffects.application

import obseffects.domain.*
import obseffects.domain.JsonValue.JsonString

import java.time.Clock

/** The effect ids this build no longer ships, and what each one became.
  *
  * ==Why this exists==
  *
  * An effect's id is chosen by the frontend and stored by reference: a route says `effectId: "worxbend-text"` and the
  * renderer looks that id up in its bundled registry. When an effect is renamed, every stored route and preset that
  * points at the old id would render as "this build does not implement that effect" — a blank OBS source — until
  * somebody re-picked the effect by hand in the admin UI.
  *
  * This is the bridge: once per start-up, every route and preset still pointing at an old id is rewritten to the new
  * one. It runs in the same database-is-reachable phase as the index creation and the builtin-sound seed, and it is
  * idempotent, because after the first run nothing matches any more.
  *
  * ==The `text` parameter==
  *
  * The four renamed effects used to be branded: their `text` parameter defaulted to `"WORXBEND"`, and a route that
  * never touched that field stored nothing for it (the admin UI stores only values that differ from the defaults). The
  * default is now a neutral placeholder, so such a route would silently start showing `"YOUR TEXT"` on air. To keep
  * what the stream was showing, the migration pins the old default explicitly on any migrated document that has no
  * `text` of its own. A route that had already set its own text is left alone.
  */
class LegacyEffectIds(routes: RouteRepository, presets: PresetRepository, clock: Clock) {

  import LegacyEffectIds.*

  /** Rewrites every stored route and preset that references a renamed effect. Returns how many documents changed. */
  def migrate(): Int = migrateRoutes() + migratePresets()

  private def migrateRoutes(): Int =
    routes.listAll().count { route =>
      Renames.get(route.effectId).exists { rename =>
        val input = RouteInput(
          slug = route.slug,
          effectId = rename.to,
          enabled = route.enabled,
          params = withPinnedDefaults(route.params, rename),
          canvas = route.canvas
        )
        // A `Left` here means the slug clashed with another route, which cannot happen when the slug is unchanged;
        // and `Right(None)` means the route vanished between the list and the replace. Neither is worth stopping
        // start-up for, so both count as "nothing migrated" and the next start-up tries again.
        routes.replace(route.id, input, clock.instant()).exists(_.isDefined)
      }
    }

  private def migratePresets(): Int =
    presets.listAll().count { preset =>
      Renames.get(preset.effectId).exists { rename =>
        val input = PresetInput(
          name = preset.name,
          effectId = rename.to,
          params = withPinnedDefaults(preset.params, rename)
        )
        presets.replace(preset.id, input, clock.instant()).exists(_.isDefined)
      }
    }

  /** Adds the old defaults for every parameter the document does not set itself. */
  private def withPinnedDefaults(params: Map[ParamKey, JsonValue], rename: Rename): Map[ParamKey, JsonValue] =
    rename.pinnedDefaults ++ params
}

object LegacyEffectIds {

  /** What an old id became, plus the defaults that changed with it and therefore have to be written out. */
  final case class Rename(to: EffectId, pinnedDefaults: Map[ParamKey, JsonValue])

  private val TextKey: ParamKey = ParamKey.unsafe("text")
  private val OldBrandedText: Map[ParamKey, JsonValue] = Map(TextKey -> JsonString("WORXBEND"))

  private def renamed(from: String, to: String): (EffectId, Rename) =
    EffectId.unsafe(from) -> Rename(EffectId.unsafe(to), OldBrandedText)

  /** Old id → new id. Add a line here whenever an effect id changes; never remove one, since a database restored from
    * an old backup can carry any id that ever existed.
    */
  val Renames: Map[EffectId, Rename] = Map(
    renamed("worxbend-text", "particle-text"),
    renamed("worxbend-fluid", "fluid-text"),
    renamed("worxbend-molecular", "molecular-text"),
    renamed("worxbend-3d-text", "jelly-text-3d")
  )
}
