// Tiny inline SVG icons — stroke-based, 16px viewbox. The shared DevAsign set
// plus the contributor-app extras (coins, gavel, briefcase, …) merged into one
// component, so screens never juggle two icon namespaces.
import React from "react";

type IconProps = { name: string; size?: number; color?: string; style?: React.CSSProperties };

const Icon = ({ name, size = 16, color = "currentColor", style }: IconProps) => {
  const s = size;
  const p: React.SVGProps<SVGSVGElement> = {
    width: s, height: s, viewBox: "0 0 16 16",
    fill: "none", stroke: color, strokeWidth: 1.4,
    strokeLinecap: "round", strokeLinejoin: "round", style
  };
  switch (name) {
    case "agent":      return <svg {...p}><circle cx="8" cy="6" r="3"/><path d="M3 14c.6-2.5 2.7-4 5-4s4.4 1.5 5 4"/><circle cx="13" cy="3" r="1.2" fill={color}/></svg>;
    case "dashboard":  return <svg {...p}><rect x="2" y="2" width="5" height="6"/><rect x="9" y="2" width="5" height="3"/><rect x="9" y="7" width="5" height="7"/><rect x="2" y="10" width="5" height="4"/></svg>;
    case "settings":   return <svg {...p}><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"/></svg>;
    case "github":     return <svg width={s} height={s} viewBox="0 0 16 16" fill={color} style={style}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>;
    case "check":      return <svg {...p}><path d="M3 8l3 3 7-7"/></svg>;
    case "chevron-r":  return <svg {...p}><path d="M6 3l5 5-5 5"/></svg>;
    case "chevron-d":  return <svg {...p}><path d="M3 6l5 5 5-5"/></svg>;
    case "play":       return <svg {...p} fill={color}><path d="M5 3l8 5-8 5z"/></svg>;
    case "search":     return <svg {...p}><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>;
    case "plus":       return <svg {...p}><path d="M8 3v10M3 8h10"/></svg>;
    case "filter":     return <svg {...p}><path d="M2 3h12l-4.5 5.5V13L6.5 11V8.5L2 3z"/></svg>;
    case "doc":        return <svg {...p}><path d="M4 1.5h5l3 3V14a.5.5 0 01-.5.5h-7a.5.5 0 01-.5-.5V2a.5.5 0 01.5-.5z"/><path d="M9 1.5v3h3M5.5 8h5M5.5 10.5h5M5.5 5.5h2"/></svg>;
    case "image":      return <svg {...p}><rect x="2" y="3" width="12" height="10"/><circle cx="5.5" cy="6.5" r="1"/><path d="M2 11l3-3 3 3 2-2 4 4"/></svg>;
    case "git":        return <svg {...p}><circle cx="4" cy="4" r="1.5"/><circle cx="12" cy="8" r="1.5"/><circle cx="4" cy="12" r="1.5"/><path d="M4 5.5v5M5.5 4h2a3 3 0 013 3v.5"/></svg>;
    case "code":       return <svg {...p}><path d="M5 4l-3 4 3 4M11 4l3 4-3 4M9.5 3l-3 10"/></svg>;
    case "link":       return <svg {...p}><path d="M7 9a3 3 0 004.2 0l2.3-2.3a3 3 0 00-4.2-4.2L8 3.8M9 7a3 3 0 00-4.2 0L2.5 9.3a3 3 0 004.2 4.2L8 12.2"/></svg>;
    case "terminal":   return <svg {...p}><rect x="2" y="3" width="12" height="10"/><path d="M5 7l2 1.5L5 10M8 10.5h3"/></svg>;
    case "warn":       return <svg {...p}><path d="M8 2l6 11H2z"/><path d="M8 7v3M8 12v.5"/></svg>;
    case "x":          return <svg {...p}><path d="M3 3l10 10M13 3L3 13"/></svg>;
    case "send":       return <svg {...p}><path d="M14 2L2 8l5 2 1 4 6-12z"/></svg>;
    case "message":    return <svg {...p}><path d="M2 3h12v8H6l-3 3V3z"/></svg>;
    case "copy":       return <svg {...p}><rect x="5" y="5" width="8" height="8"/><path d="M3 11V3h8"/></svg>;
    case "download":   return <svg {...p}><path d="M8 2v8M4 7l4 4 4-4M2 13h12"/></svg>;
    case "external":   return <svg {...p}><path d="M6 3H3v10h10V10M9 3h4v4M8 8l5-5"/></svg>;
    case "circle":     return <svg {...p}><circle cx="8" cy="8" r="6"/></svg>;
    case "dot":        return <svg {...p}><circle cx="8" cy="8" r="3" fill={color}/></svg>;
    case "spark":      return <svg {...p}><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M4 12l2-2M10 6l2-2"/></svg>;
    case "discord":    return <svg {...p}><path d="M4 5l1-1 3-.5 3 .5 1 1c1 2 1 5 .5 7l-2 1-.5-1.5M4 5c-1 2-1 5-.5 7l2 1 .5-1.5"/><circle cx="6.5" cy="9" r=".7" fill={color}/><circle cx="9.5" cy="9" r=".7" fill={color}/></svg>;
    case "lock":       return <svg {...p}><rect x="3" y="7" width="10" height="7"/><path d="M5 7V5a3 3 0 016 0v2"/></svg>;
    case "user":       return <svg {...p}><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3 2.5-5 6-5s6 2 6 5"/></svg>;
    case "bell":       return <svg {...p}><path d="M4 11V7a4 4 0 018 0v4l1 2H3l1-2zM6.5 14a1.5 1.5 0 003 0"/></svg>;
    case "globe":      return <svg {...p}><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>;
    case "shield":     return <svg {...p}><path d="M8 1l5 2v5c0 3-2 5.5-5 7-3-1.5-5-4-5-7V3l5-2z"/></svg>;
    case "eye":        return <svg {...p}><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2.2"/></svg>;
    case "eye-off":    return <svg {...p}><path d="M2 2l12 12"/><path d="M6.2 4.5C7 4.2 7.5 4 8 4c4.5 0 7 4.5 7 4.5s-.8 1.5-2.4 2.9M9.8 11.5C9 11.8 8.5 12 8 12c-4.5 0-7-4-7-4s.8-1.5 2.4-2.9"/><path d="M6.7 6.7a2.2 2.2 0 003.1 3.1"/></svg>;
    case "logout":     return <svg {...p}><path d="M9 3H3v10h6M7 8h8M12 5l3 3-3 3"/></svg>;
    case "bounties":   return <svg {...p}><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.8"/><path d="M8 1v2.2M8 12.8V15M1 8h2.2M12.8 8H15"/></svg>;
    // ── Contributor-app extras (ported from the design's CExtra set) ──────────
    case "clock":    return <svg {...p}><circle cx="8" cy="8" r="6" /><path d="M8 5v3.2l2 1.4" /></svg>;
    case "coins":    return <svg {...p}><ellipse cx="6" cy="5" rx="4" ry="2" /><path d="M2 5v3c0 1.1 1.8 2 4 2s4-.9 4-2V5" /><path d="M6 10c-2.2 0-4-.9-4-2M14 8v3c0 1.1-1.8 2-4 2-1 0-1.9-.2-2.6-.5" /><path d="M6 13c-2.2 0-4-.9-4-2v-1" /></svg>;
    case "scale":    return <svg {...p}><path d="M8 2v12M4 14h8M3 5h10M8 3l-5 2 1.6 3.2a2 2 0 01-3.2 0L3 5M8 3l5 2-1.6 3.2a2 2 0 003.2 0L13 5" /></svg>;
    case "return":   return <svg {...p}><path d="M5 3L2 6l3 3M2 6h8a4 4 0 010 8H6" /></svg>;
    case "gavel":    return <svg {...p}><path d="M2 14h7M9.5 3.5l3 3M4.5 8.5l4-4M7 6l3 3M11 2l3 3-2.5 2.5L8.5 4.5 11 2z" /></svg>;
    case "trophy":   return <svg {...p}><path d="M4 3h8v3a4 4 0 01-8 0V3zM4 4H2v1a2 2 0 002 2M12 4h2v1a2 2 0 01-2 2M6.5 10.5L6 13h4l-.5-2.5M5 13h6" /></svg>;
    case "briefcase":return <svg {...p}><rect x="2" y="5" width="12" height="8" /><path d="M6 5V3.5A1 1 0 017 2.5h2a1 1 0 011 1V5M2 8.5h12" /></svg>;
    case "moneybag": return <svg {...p}><path d="M6 4.2C3.5 5.5 2 8.5 2 10.8 2 13 4 14.5 8 14.5s6-1.5 6-3.7c0-2.3-1.5-5.3-4-6.6" /><path d="M6 4.2l.9-1.7h2.2l.9 1.7z" /><path d="M8 8v4.4M9.4 9c-.2-.7-1.1-1-1.7-.7-.8.4-.8 1.4.1 1.7.9.3.9 1.4 0 1.8-.7.3-1.5 0-1.7-.7" /></svg>;
    case "inbox":    return <svg {...p}><path d="M2 9l1.5-5.5A1 1 0 014.5 3h7a1 1 0 011 .8L14 9v3.5a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5V9z" /><path d="M2 9h3.5l1 1.5h3l1-1.5H14" /></svg>;
    case "down-in":  return <svg {...p}><path d="M8 3v7M5 7.5L8 10.5 11 7.5M3.5 13h9" /></svg>;
    case "up-out":   return <svg {...p}><path d="M8 13V6M5 8.5L8 5.5 11 8.5M3.5 3h9" /></svg>;
    case "hourglass":return <svg {...p}><path d="M4 2h8M4 14h8M5 2c0 3 6 3 6 6s-6 3-6 6M11 2c0 3-6 3-6 6s6 3 6 6" /></svg>;
    case "flag":     return <svg {...p}><path d="M4 14V2M4 3h7l-1.5 2.5L11 8H4" /></svg>;
    case "target":   return <svg {...p}><circle cx="8" cy="8" r="6" /><circle cx="8" cy="8" r="2.6" /></svg>;
    case "pr":       return <svg {...p}><circle cx="4" cy="4" r="1.6" /><circle cx="4" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><path d="M4 5.6v4.8M12 10.4V8a3 3 0 00-3-3H7.5M9 3.5L7 5.5 9 7.5" /></svg>;
    case "badge":    return <svg {...p}><circle cx="8" cy="7" r="4" /><path d="M5.5 10.5L5 14l3-1.5L11 14l-.5-3.5M6.3 7l1.1 1.1L9.9 5.6" /></svg>;
    case "sparkline":return <svg {...p}><path d="M2 11l3-4 3 2 4-6 2 3" /></svg>;
    case "trash":    return <svg {...p}><path d="M3 4h10M6 4V3a1 1 0 011-1h2a1 1 0 011 1v1M4.5 4l.6 9a1 1 0 001 .9h3.8a1 1 0 001-.9l.6-9M6.8 6.5v5M9.2 6.5v5" /></svg>;
    case "edit":     return <svg {...p}><path d="M11.2 2.3l2.5 2.5M12.4 1.1l2.5 2.5-8.7 8.7L3 13l.7-3.2z" /><path d="M2 14.2h6" /></svg>;
    default: return null;
  }
};

// Stellar chain logo (the only chain the escrow runs on today).
export const ChainLogo = ({ size = 18 }: { size?: number }) => (
  <img src="/stellar-icon.png" alt="Stellar" width={size} height={size}
       style={{ display: "block", objectFit: "contain" }} />
);

export { Icon };
export default Icon;
