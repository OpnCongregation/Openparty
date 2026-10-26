import type { ReactNode } from "react";

// Small outline icons (24x24, drawn with the current text colour). One place, so every page draws them the same way.
const P: Record<string, ReactNode> = {
  home: <path d="M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10M10 19.5v-5h4v5" />,
  tour: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></>,
  party: <path d="M5 21V4m0 1h11l-2 4 2 4H5" />,
  ussd: <><rect x="7" y="2.5" width="10" height="19" rx="2.5" /><path d="M11 18.5h2" /></>,
  members: <><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 5.2a3 3 0 0 1 0 5.6M18 14.8c1.8.7 3 2.4 3 5.2" /></>,
  dues: <><circle cx="12" cy="12" r="8.5" /><path d="M14.5 9.2c-.6-.8-1.5-1.2-2.6-1.2-1.6 0-2.6.8-2.6 2 0 3 5.3 1.4 5.3 4.2 0 1.2-1.1 2-2.7 2-1.2 0-2.2-.5-2.8-1.4M12 6.5V8m0 8v1.5" /></>,
  petitions: <><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5M9 13h7M9 17h5" /></>,
  voting: <><path d="M4 13h16l-1.5 7h-13z" /><path d="M9 13V4.5h6V13M9.8 8.2 11.5 10l3-3" /></>,
  secret: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5M12 14.5v2.5" /></>,
  desk: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  apply: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.5-3.8 3.2-5.5 7-5.5s6.5 1.7 7 5.5" /></>,
  unit: <><path d="M12 21s7-5.6 7-11a7 7 0 0 0-14 0c0 5.4 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></>,
  guardian: <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8 7.5 9.5 4.3-1.5 7.5-4.9 7.5-9.5V6z" />,
  audit: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5M8 10.5l2 2 3.5-4" /></>,
  verify: <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8 7.5 9.5 4.3-1.5 7.5-4.9 7.5-9.5V6zM8.5 12l2.5 2.5 4.5-5" />,
  framework: <path d="m12 3 9 4.5-9 4.5-9-4.5zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5" />,
  lab: <path d="M9 3h6M10 3v6l-5.5 9.5A1.6 1.6 0 0 0 5.9 21h12.2a1.6 1.6 0 0 0 1.4-2.5L14 9V3M7.5 15h9" />,
  tests: <><path d="M5 4h14v16H5z" /><path d="m8.5 9 1.5 1.5L13 7.5M8.5 15l1.5 1.5 3-3M15 10h2M15 16h2" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
};

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name] ?? P.home}
    </svg>
  );
}

/** The OpenParty mark: a ballot slot with a tick, in a rounded square. */
export function Mark({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="11" fill="#e9c878" />
      <path d="M9 21h22l-2.4 11H11.4z" fill="#0f2a23" />
      <path d="M15 21V9.5h10V21" fill="#fffdf8" stroke="#0f2a23" strokeWidth="2" strokeLinejoin="round" />
      <path d="m17.6 14.6 2.2 2.2 3.8-4.4" fill="none" stroke="#0d6b57" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
