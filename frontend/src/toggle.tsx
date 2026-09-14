import React from "react";

export const Toggle = ({ on, onClick, disabled, label }: { on: boolean; onClick: () => void; disabled?: boolean; label?: string }) => (
  <button className={`vln-sw ${on ? "" : "off"}`} onClick={onClick} disabled={disabled} aria-pressed={on} aria-label={label}>
    <i />
  </button>
);
