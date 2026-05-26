// Tiny inline SVG icons — stroke-based, 16px viewbox
import React from "react";

type IconProps = { name: string; size?: number; color?: string };

const Icon = ({ name, size = 16, color = "currentColor" }: IconProps) => {
  const s = size;
  const p: React.SVGProps<SVGSVGElement> = {
    width: s, height: s, viewBox: "0 0 16 16",
    fill: "none", stroke: color, strokeWidth: 1.4,
    strokeLinecap: "round", strokeLinejoin: "round"
  };
  switch (name) {
    case "agent":      return <svg {...p}><circle cx="8" cy="6" r="3"/><path d="M3 14c.6-2.5 2.7-4 5-4s4.4 1.5 5 4"/><circle cx="13" cy="3" r="1.2" fill={color}/></svg>;
    case "dashboard":  return <svg {...p}><rect x="2" y="2" width="5" height="6"/><rect x="9" y="2" width="5" height="3"/><rect x="9" y="7" width="5" height="7"/><rect x="2" y="10" width="5" height="4"/></svg>;
    case "settings":   return <svg {...p}><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3"/></svg>;
    case "github":     return <svg width={s} height={s} viewBox="0 0 16 16" fill={color}><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>;
    case "check":      return <svg {...p}><path d="M3 8l3 3 7-7"/></svg>;
    case "chevron-r":  return <svg {...p}><path d="M6 3l5 5-5 5"/></svg>;
    case "chevron-d":  return <svg {...p}><path d="M3 6l5 5 5-5"/></svg>;
    case "play":       return <svg {...p} fill={color}><path d="M5 3l8 5-8 5z"/></svg>;
    case "search":     return <svg {...p}><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>;
    case "plus":       return <svg {...p}><path d="M8 3v10M3 8h10"/></svg>;
    case "filter":     return <svg {...p}><path d="M2 3h12l-4.5 5.5V13L6.5 11V8.5L2 3z"/></svg>;
    case "loom":       return <svg {...p}><circle cx="8" cy="8" r="6"/><path d="M8 4v8M4 8h8M5 5l6 6M5 11l6-6"/></svg>;
    case "doc":        return <svg {...p}><path d="M4 1.5h5l3 3V14a.5.5 0 01-.5.5h-7a.5.5 0 01-.5-.5V2a.5.5 0 01.5-.5z"/><path d="M9 1.5v3h3M5.5 8h5M5.5 10.5h5M5.5 5.5h2"/></svg>;
    case "image":      return <svg {...p}><rect x="2" y="3" width="12" height="10"/><circle cx="5.5" cy="6.5" r="1"/><path d="M2 11l3-3 3 3 2-2 4 4"/></svg>;
    case "git":        return <svg {...p}><circle cx="4" cy="4" r="1.5"/><circle cx="12" cy="8" r="1.5"/><circle cx="4" cy="12" r="1.5"/><path d="M4 5.5v5M5.5 4h2a3 3 0 013 3v.5"/></svg>;
    case "code":       return <svg {...p}><path d="M5 4l-3 4 3 4M11 4l3 4-3 4M9.5 3l-3 10"/></svg>;
    case "link":       return <svg {...p}><path d="M7 9a3 3 0 004.2 0l2.3-2.3a3 3 0 00-4.2-4.2L8 3.8M9 7a3 3 0 00-4.2 0L2.5 9.3a3 3 0 004.2 4.2L8 12.2"/></svg>;
    case "terminal":   return <svg {...p}><rect x="2" y="3" width="12" height="10"/><path d="M5 7l2 1.5L5 10M8 10.5h3"/></svg>;
    case "brain":      return <svg {...p}><path d="M5 3a2 2 0 00-2 2v6a2 2 0 002 2h1V3H5zM11 3a2 2 0 012 2v6a2 2 0 01-2 2h-1V3h1z"/><path d="M6 6h1M6 10h1M9 6h1M9 10h1M6 8h4"/></svg>;
    case "warn":       return <svg {...p}><path d="M8 2l6 11H2z"/><path d="M8 7v3M8 12v.5"/></svg>;
    case "x":          return <svg {...p}><path d="M3 3l10 10M13 3L3 13"/></svg>;
    case "send":       return <svg {...p}><path d="M14 2L2 8l5 2 1 4 6-12z"/></svg>;
    case "message":    return <svg {...p}><path d="M2 3h12v8H6l-3 3V3z"/></svg>;
    case "copy":       return <svg {...p}><rect x="5" y="5" width="8" height="8"/><path d="M3 11V3h8"/></svg>;
    case "download":   return <svg {...p}><path d="M8 2v8M4 7l4 4 4-4M2 13h12"/></svg>;
    case "external":   return <svg {...p}><path d="M6 3H3v10h10V10M9 3h4v4M8 8l5-5"/></svg>;
    case "slack":      return <svg {...p}><rect x="2" y="6" width="3" height="3"/><rect x="6" y="2" width="3" height="3"/><rect x="11" y="6" width="3" height="3"/><rect x="6" y="11" width="3" height="3"/><rect x="6" y="6" width="3" height="3"/></svg>;
    case "linear":     return <svg {...p}><circle cx="8" cy="8" r="6"/><path d="M3 5l8 8M3 9l4 4M5 3l8 8M9 3l4 4"/></svg>;
    case "discord":    return <svg {...p}><path d="M4 5l1-1 3-.5 3 .5 1 1c1 2 1 5 .5 7l-2 1-.5-1.5M4 5c-1 2-1 5-.5 7l2 1 .5-1.5"/><circle cx="6.5" cy="9" r=".7" fill={color}/><circle cx="9.5" cy="9" r=".7" fill={color}/></svg>;
    case "circle":     return <svg {...p}><circle cx="8" cy="8" r="6"/></svg>;
    case "dot":        return <svg {...p}><circle cx="8" cy="8" r="3" fill={color}/></svg>;
    case "spark":      return <svg {...p}><path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M4 12l2-2M10 6l2-2"/></svg>;
    case "lock":       return <svg {...p}><rect x="3" y="7" width="10" height="7"/><path d="M5 7V5a3 3 0 016 0v2"/></svg>;
    case "user":       return <svg {...p}><circle cx="8" cy="5" r="3"/><path d="M2 14c0-3 2.5-5 6-5s6 2 6 5"/></svg>;
    case "bell":       return <svg {...p}><path d="M4 11V7a4 4 0 018 0v4l1 2H3l1-2zM6.5 14a1.5 1.5 0 003 0"/></svg>;
    case "globe":      return <svg {...p}><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/></svg>;
    case "shield":     return <svg {...p}><path d="M8 1l5 2v5c0 3-2 5.5-5 7-3-1.5-5-4-5-7V3l5-2z"/></svg>;
    case "eye":        return <svg {...p}><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2.2"/></svg>;
    case "eye-off":    return <svg {...p}><path d="M2 2l12 12"/><path d="M6.2 4.5C7 4.2 7.5 4 8 4c4.5 0 7 4.5 7 4.5s-.8 1.5-2.4 2.9M9.8 11.5C9 11.8 8.5 12 8 12c-4.5 0-7-4-7-4s.8-1.5 2.4-2.9"/><path d="M6.7 6.7a2.2 2.2 0 003.1 3.1"/></svg>;
    case "logout":     return <svg {...p}><path d="M9 3H3v10h6M7 8h8M12 5l3 3-3 3"/></svg>;
    case "swap":       return <svg {...p}><path d="M2 5h11M10 2l3 3-3 3M14 11H3M6 8l-3 3 3 3"/></svg>;
    default: return null;
  }
};
export { Icon };
export default Icon;
