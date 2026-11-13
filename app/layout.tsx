import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Demolition",
  description: "Organize, review, and group local music demos.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        data-demolition-api-port={process.env.NEXT_PUBLIC_DEMOLITION_API_PORT || process.env.DEMOLITION_API_PORT || "3001"}
        data-demolition-ui-port={process.env.NEXT_PUBLIC_DEMOLITION_UI_PORT || "3000"}
        className="antialiased"
      >
        {children}
      </body>
    </html>
  );
}
