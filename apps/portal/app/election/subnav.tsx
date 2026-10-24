"use client";
import { usePathname } from "next/navigation";

const LINKS: [string, string][] = [
  ["/election", "Candidates and results"],
  ["/election/apply", "Stand for office"],
  ["/election/vote", "Vote online"],
  ["/election/unit", "Polling unit"],
  ["/election/desk", "Admin desk"],
];

export function SubNav() {
  const path = usePathname();
  return (
    <nav className="el-sub" aria-label="Election sections">
      {LINKS.map(([href, label]) => (
        <a key={href} href={href} className={path === href ? "on" : ""} aria-current={path === href ? "page" : undefined}>{label}</a>
      ))}
    </nav>
  );
}
