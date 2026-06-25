// AgentKitAuto brand logo — PNG image asset.
//
// Renders the official AgentKitAuto icon PNG at the requested size.
// Pass `size` (px, default 42) for both width and height, `title` for the
// accessible alt text (default "AgentKitAuto"), and any other img attributes.
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
