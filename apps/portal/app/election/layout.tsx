import type { ReactNode } from "react";
import "./election.css";
import { SubNav } from "./subnav";

export const metadata = { title: "Elections: OpenParty", description: "Stand for office, vote, run a polling unit and run the contest, with the paperwork gates enforced." };

export default function ElectionLayout({ children }: { children: ReactNode }) {
  return (
    <div className="el">
      <SubNav />
      {children}
    </div>
  );
}
