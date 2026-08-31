/* The application entry point: this is the file `index.html` loads. */

import type { JSX } from "@solidjs/web";
import { render } from "@solidjs/web";
import { createRouter, useNavigate } from "@solidjs/router";
import { AdminShell } from "~/components/AdminShell";
import RoutesListPage from "~/pages/RoutesListPage";
import RouteEditorPage from "~/pages/RouteEditorPage";
import InventoryPage from "~/pages/InventoryPage";
import PresetsPage from "~/pages/PresetsPage";
import BackupPage from "~/pages/BackupPage";
import SettingsPage from "~/pages/SettingsPage";
import TwitchAdminPage from "~/pages/TwitchAdminPage";
import TwitchCallbackPage from "~/pages/TwitchCallbackPage";
import LoginPage from "~/pages/LoginPage";
import NotFoundPage from "~/pages/NotFoundPage";
import RendererPage from "~/pages/RendererPage";
import "~/styles/fonts.css";
import "~/styles/app.css";

/*
 * A note on something that used to be here, because putting it back would break live streams.
 *
 * This file used to call `publishManifest()` at module scope, which published the effect inventory
 * to the backend on *every* page load — including `/e/:slug` inside OBS. Since Phase 2 the
 * endpoint it calls, `POST /api/effects/sync`, requires a session, so every OBS browser source
 * would now receive a 401 on every load. The call moved into `AdminShell`, where it runs after the
 * session check and only for admin pages. See the long comment on `SignedInArea` there.
 */

/**
 * Sends the visitor from "/" to "/admin".
 *
 * Solid Router used to ship a `<Navigate href="…" />` component for this. It no longer exists, and
 * the documented replacement is to call `useNavigate()` while the component is being set up —
 * which is what this does. The component itself draws nothing, so it returns `null`.
 */
function RedirectToAdmin(): JSX.Element {
  const navigate = useNavigate();
  navigate("/admin", { replace: true });
  return null;
}

/**
 * The route table.
 *
 * In Solid Router 2 routes are **plain configuration objects**, not JSX. There is no `<Router>`
 * with `<Route>` children any more: you build the table once, at module scope, and the value
 * `createRouter` hands back *is* the provider component you render.
 *
 * Building it outside the component tree is what lets the router type its URLs and compile its
 * matcher a single time, shared by every mount.
 */
const Router = createRouter({
  routes: [
    // "/" is not a page of its own; the admin route list is the real home.
    { path: "/", component: RedirectToAdmin },

    /*
     * The sign-in form.
     *
     * It is a route of its own rather than a child of the admin shell below, because the shell is
     * what redirects here: a guard that has to except its own login page is a guard with a hole in
     * it. Two static segments make this the most specific pattern for the exact path
     * "/admin/login", and the router ranks branches by specificity, so it wins over the "/admin"
     * subtree and over the "*" catch-all without depending on the order of this array.
     */
    { path: "/admin/login", component: LoginPage },

    /*
     * Every /admin path is wrapped in the shell (top bar, navigation, health indicator).
     * Nesting them under one parent means the shell is rendered once and stays mounted while you
     * move between the pages inside it — the parent's `component` receives the matched child as
     * `props.children`.
     */
    {
      path: "/admin",
      component: AdminShell,
      children: [
        { path: "/", component: RoutesListPage },
        { path: "/routes/new", component: () => <RouteEditorPage mode="create" /> },
        { path: "/routes/:id", component: () => <RouteEditorPage mode="edit" /> },
        { path: "/effects", component: InventoryPage },
        /*
         * Presets and backup are children of "/admin" so they inherit the shell's session gate,
         * exactly like every other admin page. Only "/admin/login" is a sibling of the subtree
         * rather than a child, because it is the page the gate sends people to.
         */
        { path: "/presets", component: PresetsPage },
        { path: "/backup", component: BackupPage },
        { path: "/settings", component: SettingsPage },
        /*
         * The Twitch moderation dashboard. A child of "/admin" like every other admin page, so it
         * inherits the shell's session gate: the endpoints behind it can ban people, and nothing
         * that can ban people is reachable without a session.
         *
         * It is listed above "/twitch/callback" only for readability — the router ranks branches
         * by how specific they are, so the two static segments of the callback path win over this
         * one regardless of the order here.
         */
        { path: "/twitch", component: TwitchAdminPage },
        /*
         * Where Twitch's OAuth redirect lands after "Connect with Twitch" on the Settings page.
         * A child of "/admin" on purpose: the completion endpoint it calls is protected, and only
         * a signed-in operator can have started the flow, so the shell's session gate is the right
         * front door for it.
         */
        { path: "/twitch/callback", component: TwitchCallbackPage },
      ],
    },

    /*
     * The renderer is deliberately OUTSIDE the admin shell, and this is load-bearing rather than
     * cosmetic.
     *
     * The obvious reason: OBS must receive a bare, fully transparent page with no navigation bar
     * in it. The one that matters more: the admin shell checks the session and redirects anyone
     * without one to the login page. An OBS browser source cannot sign in — it opens one URL,
     * unattended, for the length of a broadcast — so a renderer wrapped in the shell would replace
     * a live layer with a login form the moment a session expired, with nothing in OBS to say why.
     *
     * Every endpoint this page calls is public for the same reason (see `docs/CONTRACT.md` §4), and
     * the 401 handler that performs the redirect is registered by the shell, so it does not even
     * exist while this page is on screen. If you are restructuring the router, keep all three of
     * those properties: no shell, no protected call, no handler.
     */
    { path: "/e/:slug", component: RendererPage },

    // Anything else: a plain 404 inside the admin chrome.
    {
      path: "*",
      component: () => (
        <AdminShell>
          <NotFoundPage />
        </AdminShell>
      ),
    },
  ],
});

const root = document.getElementById("root");
if (!root) throw new Error('index.html is missing its <div id="root"> element.');

/*
 * Mount the router.
 *
 * Its child is a *render prop* — a function, not markup. The function stays mounted for the whole
 * life of the app and receives whichever page matched the current URL as `props.children`. This
 * app has no chrome above the router (the admin shell is a route of its own, and the OBS page must
 * have none at all), so the function passes its children straight through.
 */
render(() => <Router>{(props) => <>{props.children}</>}</Router>, root);
