import "./globals.css";

export const metadata = {
  title: "MP3 Medley Maker",
  description: "Trim and merge MP3 files with fade in/out to create medleys."
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
