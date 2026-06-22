import React from "react";

/** Dorsia BD Pipeline — three-part color wordmark. */
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
      <span style={{ fontSize: size, fontWeight: 500, letterSpacing: "0.14em", color: "#111827" }}>Dorsia</span>
      <span style={{ fontSize: size, fontWeight: 500, color: "#949494", marginLeft: gap }}>BD</span>
      <span style={{ fontSize: size, fontWeight: 500, color: "#9580ff", marginLeft: gap }}>Pipeline</span>
    </span>
  );
}
