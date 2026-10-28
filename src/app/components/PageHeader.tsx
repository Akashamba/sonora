import type { ReactNode } from "react";

export function PageHeader({ title }: { title: ReactNode }) {
  return <header className="page-heading"><h1>{title}</h1></header>;
}
