package obseffects.application

import obseffects.domain.{
  GroupOp,
  RawSoundboard,
  RawSoundboardCondition,
  RawSoundboardRule,
  Soundboard,
  SoundboardCondition,
  SoundboardRule,
  ValidationIssue
}

import java.security.SecureRandom
import java.util.regex.{Pattern, PatternSyntaxException}

import scala.util.matching.Regex

object SoundboardService {

  /** One hundred rules is far beyond any real soundboard, and low enough that the overlay effect can afford to test
    * every enabled rule against every chat message without thinking about it.
    */
  val MaxRules: Int = 100

  /** The same 64-character bound preset and sound names have: long enough for any real label, short enough to render
    * anywhere.
    */
  val MaxLabelLength: Int = 64

  /** A leaf's value — a command token, a substring, a regex source, an emote name, an emoji, a username. 200 characters
    * is roomy for a regex and absurd for the rest, and it keeps a pasted paragraph from becoming a "value".
    */
  val MaxValueLength: Int = 200

  /** Sound names are capped at 64 characters at upload time (`SoundService.MaxNameLength`), so a reference to one
    * shares the bound.
    */
  val MaxSoundLength: Int = 64

  /** How deep a condition tree may nest, counting the root: five levels of grouping is already more than any readable
    * rule needs, and a hard cap keeps both the validator and the query-builder UI honestly bounded.
    */
  val MaxDepth: Int = 5

  /** A group combines at least one child (an empty `and` would vacuously match everything, an empty `or` nothing — both
    * are more likely a mistake than a wish) and at most twenty.
    */
  val MaxGroupChildren: Int = 20

  /** The total number of nodes — groups and leaves together — one rule's tree may contain. The overlay walks the whole
    * tree per chat message, so the cap is a promise about evaluation cost, not just about payload size.
    */
  val MaxConditionsPerRule: Int = 50

  /** The shape of a server-assigned rule id: exactly 8 lowercase hexadecimal characters. A client-sent id that does not
    * match is not an error — it is treated as absent and replaced with a fresh id, so a hand-written file cannot
    * smuggle arbitrary strings into a field the server owns.
    */
  val IdPattern: Regex = "^[0-9a-f]{8}$".r
}

/** The use cases around the soundboard: the ordered rule list mapping condition trees over chat messages to stored
  * sounds, edited as one document by the admin UI and read (publicly) by the `soundboard` overlay effect.
  *
  * The whole board is saved in one PUT rather than rule by rule because order is part of the data — first match wins —
  * and a list whose order matters is easiest to keep consistent when every save carries the entire list.
  *
  * @param random
  *   the source of fresh rule ids, injected like every other dependency so the wiring owns the single process-wide
  *   `SecureRandom` instance.
  */
final class SoundboardService(repository: SettingsRepository, random: SecureRandom) {

  import SoundboardService.*

  /** The stored soundboard; an empty rule list when nothing has been saved yet. */
  def get(): Soundboard = repository.loadSoundboard()

  /** Validates and stores a whole soundboard, and answers with what was stored — including the ids the server assigned
    * to rules that arrived without one, which is how the admin UI learns them.
    *
    * Every problem in the request is reported together in a single `VALIDATION_FAILED`, with dotted `field` paths
    * (`rules[3].condition.children[0].value`) pointing at the offending node, the same all-at-once style the import
    * endpoint uses.
    */
  def save(raw: RawSoundboard): Either[AppError, Soundboard] = {
    val issues = sizeIssue(raw.rules).toList ++
      raw.rules.zipWithIndex.flatMap(ruleIssues) ++
      duplicateIdIssues(raw.rules)
    if (issues.nonEmpty) Left(AppError.ValidationFailed(issues))
    else Right(repository.saveSoundboard(Soundboard(withIds(raw.rules))))
  }

  // -------------------------------------------------------------------------------------------

  private def sizeIssue(rules: List[RawSoundboardRule]): Option[ValidationIssue] =
    if (rules.length > MaxRules) Some(ValidationIssue("rules", s"must contain at most $MaxRules rules")) else None

  private def ruleIssues(rule: RawSoundboardRule, index: Int): List[ValidationIssue] = {
    val field = (name: String) => s"rules[$index].$name"

    val labelIssue = lengthIssue(field("label"), rule.label.trim, MaxLabelLength)
    val soundIssue = lengthIssue(field("sound"), rule.sound.trim, MaxSoundLength)
    val sizeIssue =
      if (conditionCount(rule.condition) > MaxConditionsPerRule)
        Some(ValidationIssue(field("condition"), s"must contain at most $MaxConditionsPerRule conditions in total"))
      else None

    labelIssue.toList ++ sizeIssue.toList ++ conditionIssues(rule.condition, field("condition"), depth = 1) ++
      soundIssue.toList
  }

  private def lengthIssue(field: String, value: String, max: Int): Option[ValidationIssue] =
    if (value.isEmpty) Some(ValidationIssue(field, "must contain at least one non-space character"))
    else if (value.length > max) Some(ValidationIssue(field, s"must be at most $max characters"))
    else None

  private def conditionCount(condition: RawSoundboardCondition): Int =
    1 + condition.children.getOrElse(Nil).map(conditionCount).sum

  /** Walks the tree, reporting every problem it finds with a dotted path into the request
    * (`rules[3].condition.children[0].value`). `depth` counts the root as 1.
    */
  private def conditionIssues(condition: RawSoundboardCondition, path: String, depth: Int): List[ValidationIssue] =
    condition.`type` match {
      case "group"   => groupIssues(condition, path, depth)
      case "command" =>
        valueIssues(condition, s"$path.value", minLength = 1) ++ commandShapeIssue(condition, s"$path.value")
      case "contains" | "user" => valueIssues(condition, s"$path.value", minLength = 1)
      case "regex" => valueIssues(condition, s"$path.value", minLength = 1) ++ regexIssue(condition, s"$path.value")
      // An empty emote or emoji value is meaningful — it reads as "the message has ANY emote/emoji".
      case "emote" | "emoji" => valueIssues(condition, s"$path.value", minLength = 0)
      case "event"           => eventIssue(condition, s"$path.value")
      case other             =>
        List(
          ValidationIssue(
            s"$path.type",
            s"'$other' is not a condition type; use one of ${SoundboardCondition.TypeNames.mkString(", ")}"
          )
        )
    }

  private def groupIssues(condition: RawSoundboardCondition, path: String, depth: Int): List[ValidationIssue] = {
    val opIssue = condition.op.flatMap(GroupOp.fromWire) match {
      case Some(_) => None
      case None    => Some(ValidationIssue(s"$path.op", s"must be one of ${GroupOp.allNames.mkString(", ")}"))
    }

    val children = condition.children.getOrElse(Nil)
    val childrenIssue =
      if (children.isEmpty) Some(ValidationIssue(s"$path.children", "must contain at least one condition"))
      else if (children.length > MaxGroupChildren)
        Some(ValidationIssue(s"$path.children", s"must contain at most $MaxGroupChildren conditions"))
      else None

    if (depth > MaxDepth)
      // One report at the too-deep group itself, without recursing into a subtree whose every node would repeat the
      // same complaint.
      List(ValidationIssue(path, s"groups may nest at most $MaxDepth levels deep"))
    else
      opIssue.toList ++ childrenIssue.toList ++ children.zipWithIndex.flatMap((child, index) =>
        conditionIssues(child, s"$path.children[$index]", depth + 1)
      )
  }

  private def valueIssues(condition: RawSoundboardCondition, path: String, minLength: Int): List[ValidationIssue] = {
    val value = condition.value.getOrElse("")
    if (value.length < minLength) List(ValidationIssue(path, "must contain at least one character"))
    else if (value.length > MaxValueLength) List(ValidationIssue(path, s"must be at most $MaxValueLength characters"))
    else Nil
  }

  private def commandShapeIssue(condition: RawSoundboardCondition, path: String): List[ValidationIssue] =
    if (condition.value.getOrElse("").exists(_.isWhitespace))
      List(ValidationIssue(path, "a command is a single first-word token and cannot contain whitespace"))
    else Nil

  private def eventIssue(condition: RawSoundboardCondition, path: String): List[ValidationIssue] =
    condition.value.filter(SoundboardCondition.EventNames.contains) match {
      case Some(_) => Nil
      case None    => List(ValidationIssue(path, s"must be one of ${SoundboardCondition.EventNames.mkString(", ")}"))
    }

  /** Compiles the regex for early feedback only. The overlay evaluates the pattern with the *browser's* engine, which
    * accepts a slightly different dialect, so this check catches typos at save time without promising the two engines
    * agree; a pattern that later fails to compile in the browser evaluates as a non-match in the effect.
    *
    * `Pattern.compile` reports failure by throwing, so the catch here is a boundary around that Java API, not control
    * flow of our own.
    */
  private def regexIssue(condition: RawSoundboardCondition, path: String): List[ValidationIssue] =
    try {
      val _ = Pattern.compile(condition.value.getOrElse(""))
      Nil
    } catch {
      case e: PatternSyntaxException =>
        List(ValidationIssue(path, s"is not a valid regular expression: ${e.getDescription}"))
    }

  /** Two rules claiming the same (valid) id would make per-rule state in the overlay ambiguous, so the later claim is
    * reported rather than silently reassigned — the operator meant *something* by sending the same id twice, and
    * guessing which rule keeps it would be wrong half the time.
    */
  private def duplicateIdIssues(rules: List[RawSoundboardRule]): List[ValidationIssue] = {
    val claimed = rules.zipWithIndex.flatMap((rule, index) => validClientId(rule).map(id => (id, index)))
    claimed
      .groupBy((id, _) => id)
      .values
      .flatMap(_.drop(1))
      .toList
      .sortBy((_, index) => index)
      .map((id, index) => ValidationIssue(s"rules[$index].id", s"duplicates the id '$id' of an earlier rule"))
  }

  private def validClientId(rule: RawSoundboardRule): Option[String] = rule.id.filter(IdPattern.matches)

  /** Turns validated raw rules into stored ones: kept client ids stay, everything else gets a fresh id that collides
    * with neither a kept id nor another fresh one. `label` and `sound` are stored trimmed — trimming is part of the
    * rule their lengths were checked against.
    */
  private def withIds(rules: List[RawSoundboardRule]): List[SoundboardRule] = {
    var taken = rules.flatMap(validClientId).toSet
    rules.map { rule =>
      val id = validClientId(rule).getOrElse {
        val fresh = freshId(taken)
        taken += fresh
        fresh
      }
      SoundboardRule(
        id = id,
        label = rule.label.trim,
        condition = toCondition(rule.condition),
        sound = rule.sound.trim,
        enabled = rule.enabled
      )
    }
  }

  /** Turns a validated raw tree into the domain one. The fallbacks (`And`, empty children, empty value) can never fire
    * on a tree that passed validation; they exist only because the compiler cannot see that.
    */
  private def toCondition(raw: RawSoundboardCondition): SoundboardCondition = {
    val value = raw.value.getOrElse("")
    raw.`type` match {
      case "group" =>
        SoundboardCondition.Group(
          op = raw.op.flatMap(GroupOp.fromWire).getOrElse(GroupOp.And),
          negate = raw.negate.getOrElse(false),
          children = raw.children.getOrElse(Nil).map(toCondition)
        )
      case "contains" => SoundboardCondition.Contains(value)
      case "regex"    => SoundboardCondition.Regex(value)
      case "emote"    => SoundboardCondition.Emote(value)
      case "emoji"    => SoundboardCondition.Emoji(value)
      case "event"    => SoundboardCondition.Event(value)
      case "user"     => SoundboardCondition.User(value)
      case _          => SoundboardCondition.Command(value)
    }
  }

  /** Eight random hexadecimal characters. With at most 100 rules a collision is vanishingly unlikely, and the loop
    * makes it impossible rather than unlikely.
    */
  private def freshId(taken: Set[String]): String =
    LazyList
      .continually(f"${random.nextInt() & 0xffffffffL}%08x")
      .dropWhile(taken.contains)
      .head
}
