import type { JSX } from "@solidjs/web";

/** The page shown for any URL the router does not recognise. */
export default function NotFoundPage(): JSX.Element {
  return (
    <div class="empty">
      <h1>Page not found</h1>
      <p class="muted">
        There is nothing at this address. If you were aiming for an OBS source, its URL looks like{" "}
        <code>/e/&lt;slug&gt;</code>.
      </p>
      {/* A plain anchor: Solid Router 2 intercepts same-origin clicks itself, so there is no
          link component to import. */}
      <a href="/admin" class="btn btn-primary">
        Back to routes
      </a>
    </div>
  );
}
