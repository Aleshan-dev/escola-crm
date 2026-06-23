import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sara CRM — Matrículas",
  description: "CRM e agente IA para matrículas escolares",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body className="antialiased bg-slate-50 text-slate-900">{children}</body>
    </html>
  );
}
