import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "OpenParty", description: "Public log verifier and USSD simulator" };

export default function Root({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <strong>OpenParty</strong>
          <nav><a href="/">Log verifier</a><a href="/framework">Framework</a><a href="/lab">Rules lab</a><a href="/tests">Test results</a><a href="/ussd">USSD simulator</a></nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
