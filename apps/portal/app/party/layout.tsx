import type { ReactNode } from "react";
import "./party.css";

export const metadata = { title: "DDPN: the party page", description: "What a member sees: the party, its rules and its money, with every setting checked against the law." };

export default function PartyLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
