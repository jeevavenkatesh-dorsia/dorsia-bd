import React, { useState } from "react";
import { supabase } from "../lib/supabase.js";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("password");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (mode === "magic") {
        const { error: err } = await supabase.auth.signInWithOtp({
          email: email.trim(),
          options: { emailRedirectTo: window.location.origin },
        });
        if (err) throw err;
        setMessage("Check your email for a sign-in link.");
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (err) throw err;
      }
    } catch (err) {
      setError(err.message || "Sign in failed.");
    } finally {
      setBusy(false);
    }
  };

  const box = {
    fontSize: 14, padding: "10px 12px", borderRadius: 10,
    border: "1px solid #e5e7eb", width: "100%", boxSizing: "border-box",
  };

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "linear-gradient(160deg, #f8f7fb 0%, #ede9fe 100%)", padding: 24,
    }}>
      <div style={{
        width: "100%", maxWidth: 400, background: "#fff", borderRadius: 20,
        border: "1px solid #eef0f4", padding: "32px 28px", boxShadow: "0 12px 40px rgba(30,27,75,0.08)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
          <span style={{
            width: 36, height: 36, borderRadius: 10, background: "#1e1b4b", color: "#fff",
            display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700,
          }}>D</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: "#0f172a" }}>Dorsia BD Pipeline</span>
        </div>
        <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 24px", lineHeight: 1.5 }}>
          Sign in with your Dorsia account. Access is restricted to invited team members.
        </p>

        <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            type="email"
            required
            autoComplete="email"
            placeholder="Work email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            style={box}
          />
          {mode === "password" && (
            <input
              type="password"
              required
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={box}
            />
          )}
          <button
            type="submit"
            disabled={busy}
            style={{
              marginTop: 4, padding: "11px 16px", borderRadius: 10, border: "none",
              background: busy ? "#a78bfa" : "#6d28d9", color: "#fff",
              fontWeight: 600, fontSize: 14, cursor: busy ? "default" : "pointer",
            }}
          >
            {busy ? "Signing in…" : mode === "magic" ? "Send magic link" : "Sign in"}
          </button>
        </form>

        <button
          type="button"
          onClick={() => { setMode(m => m === "magic" ? "password" : "magic"); setError(""); setMessage(""); }}
          style={{
            marginTop: 14, background: "none", border: "none", padding: 0,
            color: "#7c3aed", fontSize: 13, cursor: "pointer", fontWeight: 500,
          }}
        >
          {mode === "magic" ? "Use password instead" : "Use magic link instead"}
        </button>

        {message && <p style={{ marginTop: 16, fontSize: 13, color: "#047857" }}>{message}</p>}
        {error && <p style={{ marginTop: 16, fontSize: 13, color: "#b91c1c" }}>{error}</p>}
      </div>
    </div>
  );
}
