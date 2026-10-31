import type { Metadata } from "next";
import { FutureDeck } from "@/components/future/FutureDeck";
import "./future.css";

export const metadata: Metadata = { title: "Future updates · Cuepoint" };

export default function Page() {
  return (
    <div className="fu-page">
      <FutureDeck />
    </div>
  );
}
