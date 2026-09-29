import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Plagiatsprüfer",
  description: "Kostenlose Plagiatsprüfung: findet wörtliche Übernahmen, leicht veränderte Passagen und Paraphrasen im Internet, auf Wikipedia und in wissenschaftlichen Quellen.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
