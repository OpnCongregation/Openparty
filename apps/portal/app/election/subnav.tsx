"use client";
import { usePathname } from "next/navigation";
import { useModules } from "../modules";
import { visibleLinks } from "../../lib/modules";

const LINKS: [string, string][] = [
  ["/election", "Candidates and results"],
  ["/election/apply", "Stand for office"],
  ["/election/vote", "Vote online"],
  ["/election/unit", "Polling unit"],
  ["/election/desk", "Admin desk"],
  ["/election/guardian", "Guardians"],
  ["/election/audit", "Audit"],
];

export function SubNav() {
  const path = usePathname();
  const { modules } = useModules();
  return (
    <nav className="el-sub" aria-label="Election sections">
      {visibleLinks(LINKS, modules).map(([href, label]) => (
        <a key={href} href={href} className={path === href ? "on" : ""} aria-current={path === href ? "page" : undefined}>{label}</a>
      ))}
    </nav>
  );
}
