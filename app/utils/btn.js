// Native button styles that bypass App Bridge postMessage issues
const base = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "6px",
  borderRadius: "6px",
  cursor: "pointer",
  fontSize: "14px",
  fontWeight: "500",
  lineHeight: "1.4",
  textDecoration: "none",
  transition: "opacity 0.15s",
  whiteSpace: "nowrap",
};

export const btn = {
  primary: { ...base, padding: "8px 16px", background: "#2c6ecb", color: "white", border: "none" },
  secondary: { ...base, padding: "8px 16px", background: "white", color: "#202223", border: "1px solid #8c9196" },
  critical: { ...base, padding: "8px 16px", background: "#d72c0d", color: "white", border: "none" },
  plain:    { ...base, padding: "8px 16px", background: "transparent", color: "#2c6ecb", border: "none" },
  slim:     { padding: "4px 10px", fontSize: "12px" },
  disabled: { opacity: 0.6, cursor: "not-allowed" },
};

export function btnStyle(variant = "secondary", opts = {}) {
  const style = { ...(btn[variant] || btn.secondary) };
  if (opts.slim) Object.assign(style, btn.slim);
  if (opts.disabled) Object.assign(style, btn.disabled);
  return style;
}
