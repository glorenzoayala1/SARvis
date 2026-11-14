import "maplibre-gl/dist/maplibre-gl.css";
import "./globals.css";

export const metadata = { title: "SARvis: NISAR ground motion", description: "Ground motion from NISAR L-band radar interferometry" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
