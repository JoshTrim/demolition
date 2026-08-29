import type { Metadata } from "next";
import { Geist, Geist_Mono, Press_Start_2P } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const pixelDisplay = Press_Start_2P({
  variable: "--font-pixel-display",
  subsets: ["latin"],
  weight: "400",
});

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
        className={`${geistSans.variable} ${geistMono.variable} ${pixelDisplay.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
