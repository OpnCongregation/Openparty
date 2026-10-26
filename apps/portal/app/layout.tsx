import type { ReactNode } from "react";
import "./globals.css";
import { PortalProvider } from "./modules";
import { Shell } from "./shell";

export const metadata = { title: "OpenParty", description: "Demo and test bench for OpenParty: the rules, the money and the votes of a party, on a public record." };
export const viewport = { width: "device-width", initialScale: 1 };

export default function Root({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500&family=IBM+Plex+Mono:wght@400;500&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body>
        <PortalProvider>
          <Shell>{children}</Shell>
        </PortalProvider>
      </body>
    </html>
  );
}
