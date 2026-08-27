package obseffects.tools

import obseffects.domain.{PasswordHash, Passwords}

/** A small command-line helper that turns a password into the bcrypt hash `ADMIN_PASSWORD_HASH` expects.
  *
  * The server refuses to start without that variable, so without a way to produce a value for it nobody could sign in
  * at all. Run it from the `backend` directory, inside the container that already has a Java runtime:
  *
  * {{{
  * docker compose run --rm --no-deps backend mill --no-daemon runMain obseffects.tools.HashPassword
  * }}}
  *
  * It asks for the password twice — reading it without echoing when it is attached to a terminal — and then prints the
  * hash. The prompts and the advice around it go to standard error and the bare hash to standard output, so a caller
  * that wants only the hash can keep the two apart; note that Mill prints progress lines of its own around all of it.
  *
  * **The password is never taken as a command-line argument.** Arguments are visible to every other process on the
  * machine through `ps`, and they end up in the shell's history file, where a password that was meant to be typed once
  * lives on for months. Reading from the terminal avoids both.
  *
  * `backend/README.md` also documents a way to do this with no Scala involved, using Apache's `htpasswd` from a
  * throwaway container. Either produces a value this server accepts.
  */
object HashPassword {

  def main(args: Array[String]): Unit = {
    val _ = args

    val password = Option(System.console()) match {
      case Some(console) =>
        // A terminal: read without echoing, and ask twice. A password nobody can see while typing
        // is a password that is easy to mistype, and finding that out now is much cheaper than
        // finding it out from a login form that only ever says "Incorrect password".
        val first = new String(console.readPassword("Password: "))
        val second = new String(console.readPassword("Again:    "))
        if (first != second) {
          System.err.println("The two entries do not match. Nothing was written; run it again.")
          sys.exit(1)
        }
        first

      case None =>
        // No terminal — the tool is being piped into, e.g. `echo 'hunter2' | ... runMain ...`.
        // There is nothing to echo and no point asking twice.
        Option(scala.io.StdIn.readLine()).getOrElse("")
    }

    if (password.isEmpty) {
      System.err.println("An empty password is not accepted.")
      sys.exit(1)
    }

    if (password.length > Passwords.MaxPasswordLength) {
      System.err.println(
        s"The API accepts at most ${Passwords.MaxPasswordLength} characters, so this would never work."
      )
      sys.exit(1)
    }

    val hash = Passwords.hash(password)

    System.err.println("")
    System.err.println("Put this in your .env file, in SINGLE quotes — a bcrypt hash is full of '$',")
    System.err.println("which both a shell and Docker Compose would otherwise read as a variable:")
    System.err.println("")
    System.err.println(s"  ADMIN_PASSWORD_HASH='${hash.value}'")
    System.err.println("")

    // Standard output carries the bare hash and nothing else, so the command can be piped.
    println(hash.value)

    // A last check that what was printed is a value this server will accept on the way back in.
    // It costs a millisecond and it turns "the hash is subtly wrong" into a failure here rather
    // than into a container that refuses to start.
    PasswordHash.parse(hash.value) match {
      case Right(_)      => ()
      case Left(problem) =>
        System.err.println(s"Something is wrong with the hash that was just produced: it $problem")
        sys.exit(1)
    }
  }
}
