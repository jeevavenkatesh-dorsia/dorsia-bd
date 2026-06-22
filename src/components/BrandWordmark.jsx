import React from "react";

/** DORSIA BD PIPELINE — three-part color wordmark. */
export default function BrandWordmark({ size = 16 }) {
  const gap = Math.round(size * 0.55);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        lineHeight: 1,
        userSelect: "none",
      }}
    >
      <span style={{ fontSize: size, fontWeight: 500, letterSpacing: "0.2em", color: "#111827" }}>DORSIA</span>
      <span style={{ fontSize: size, fontWeight: 500, color: "#949494", marginLeft: gap }}>BD</span>
      <span style={{ fontSize: size, fontWeight: 500, color: "#9580ff", marginLeft: gap }}>PIPELINE</span>
    </span>
  );
}
