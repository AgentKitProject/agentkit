// AgentKitAuto brand icon — PNG asset wrapper.
//
// Renders the official AgentKitAuto icon PNG at a given square size.
// Use this for icon-only contexts (favicons, sidebar icons, etc.).
// For the full wordmark (icon + text), use <img src="/agentkitauto-logo.png"> directly.
import type React from "react";

export type AutoLogoProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  size?: number;
  title?: string;
};

export function AutoLogo({ size = 42, title = "AgentKitAuto", ...props }: AutoLogoProps) {
  return (
    <img
      src="/agentkitauto-icon.png"
      width={size}
      height={size}
      alt={title}
      style={{ display: "block" }}
      {...props}
    />
  );
}

export default AutoLogo;
