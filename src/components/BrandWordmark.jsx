import React from "react";

/** DORSIA BD PIPELINE — three-part color wordmark. */
export default function BrandWordmark({ size = 16, onClick }) {
  const gap = Math.round(size * 0.55);
  const content = (
    <>
      <span style={{ fontSize: size, fontWeight: 500, letterSpacing: "0.2em", color: "#111827" }}>DORSIA</span>
      <span style={{ fontSize: size, fontWeight: 500, color: "#949494", marginLeft: gap }}>BD</span>
      <span style={{ fontSize: size, fontWeight: 500, color: "#9580ff", marginLeft: gap }}>PIPELINE</span>
    </>
  );

  if (!onClick) {
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
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title="Go to Pipeline"
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        lineHeight: 1,
        userSelect: "none",
        background: "none",
        border: "none",
        padding: "4px 2px",
        margin: 0,
        cursor: "pointer",
        borderRadius: 8,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = "#faf5ff"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "none"; }}
    >
      {content}
    </button>
  );
}
