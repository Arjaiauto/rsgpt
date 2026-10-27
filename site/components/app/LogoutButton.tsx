"use client";

import { logout } from "@/app/login/actions";
import { IconLogout } from "@/components/Icons";
import { player } from "@/components/player/store";

/** Stops the player (pause, clear the clip, close the mini player) before the server logs out and redirects. */
export function LogoutButton() {
  return (
    <form action={logout} onSubmit={() => player.close()}>
      {/* A text pill on wide screens; under 820px an icon button so the phone top bar never wraps. */}
      <button className="pill pill--ghost logout" type="submit" aria-label="Log out">
        <IconLogout />
        <span>Log out</span>
      </button>
    </form>
  );
}
