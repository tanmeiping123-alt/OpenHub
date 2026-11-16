import type { Metadata } from "next";
import "./globals.css";
import "./community.css";
import "./pelican.css";
import "./studio.css";
import "./billing.css";

export const metadata: Metadata = {
  title: "PromptMaster AI",
  description: "Create, refine, test and share reusable AI prompts.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
