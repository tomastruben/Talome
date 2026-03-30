import { ImageResponse } from "next/og";

export const runtime = "nodejs";
export const alt = "Talome — The Self-Evolving Server";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OGImage() {
  return new ImageResponse(
    (
      <div
        style={{
          background: "#1a1a1a",
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
        }}
      >
        <div
          style={{
            fontSize: 80,
            fontWeight: 600,
            color: "white",
            letterSpacing: "-0.02em",
          }}
        >
          Talome
        </div>
        <div
          style={{
            fontSize: 28,
            color: "#b4b4b4",
            letterSpacing: "0.01em",
          }}
        >
          The Self-Evolving Server
        </div>
        <div
          style={{
            fontSize: 20,
            color: "#666666",
            marginTop: 8,
          }}
        >
          Install apps. Fix problems. Improve its own code.
        </div>
      </div>
    ),
    { ...size }
  );
}
