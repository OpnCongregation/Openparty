import type { ReactNode } from "react";
import { ModuleGate } from "../modules";

export default function UssdLayout({ children }: { children: ReactNode }) {
  return <ModuleGate>{children}</ModuleGate>;
}
