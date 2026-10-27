import { IconUser } from "@/components/Icons";
import { EmptyState } from "@/components/states";

export default function GuestNotFound() {
  return (
    <EmptyState
      icon={<IconUser />}
      title="We couldn't find that guest"
      text="The link may be old, or the guest isn't in the archive. Browse all guests to find them."
      actions={[{ label: "Browse all guests", href: "/guests", primary: true }]}
    />
  );
}
