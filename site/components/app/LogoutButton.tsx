"use client";

import { logout } from "@/app/login/actions";
import { player } from "@/components/player/store";

/** Stops the player (pause, clear the clip, close the mini player) before the server logs out and redirects. */
export function LogoutButton() {
  return (
    <form action={logout} onSubmit={() => player.close()}>
      <button className="pill pill--ghost" type="submit">Log out</button>
    </form>
  );
}
