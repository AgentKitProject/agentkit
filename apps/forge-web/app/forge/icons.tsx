// Inline SVG icons (no lucide-react dependency on the web).
// Sized to match the desktop sidebar (18px) and card icons (20px).
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 18, ...props }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props
  };
}

export const PackageIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M16.5 9.4 7.5 4.21" />
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </svg>
);

export const HammerIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m15 12-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9" />
    <path d="M17.64 15 22 10.64" />
    <path d="m20.91 11.7-1.25-1.25c-.6-.6-.93-1.4-.93-2.25v-.86L16.01 4.6a5.56 5.56 0 0 0-3.94-1.64H9l.92.82A6.18 6.18 0 0 1 12 8.4v1.56l2 2h.86c.85 0 1.65.34 2.25.93l1.25 1.25" />
  </svg>
);

export const PlayIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="10" />
    <polygon points="10 8 16 12 10 16 10 8" />
  </svg>
);

export const ImportIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <rect width="20" height="5" x="2" y="3" rx="1" />
    <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
    <path d="m9 12 3 3 3-3" />
    <path d="M12 9v6" />
  </svg>
);

export const ExportIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 20h16" />
    <path d="M12 4v12" />
    <path d="m8 8 4-4 4 4" />
  </svg>
);

export const UploadIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" x2="12" y1="3" y2="15" />
  </svg>
);

export const PlugIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 22v-5" />
    <path d="M9 8V2" />
    <path d="M15 8V2" />
    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
  </svg>
);

export const UserIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="8" r="5" />
    <path d="M20 21a8 8 0 0 0-16 0" />
  </svg>
);

export const SettingsIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const InfoIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </svg>
);

export const SparklesIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9.94 14.06 6 18l-1.5-1.5L8.44 12.5 4.5 8.56 6 7.06 9.94 11 12 6l2.06 5L18 7.06l1.5 1.5L15.56 12.5l3.94 3.94L18 18l-3.94-3.94L12 19z" />
  </svg>
);

export const FileIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v5h5" />
  </svg>
);

export const GitIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <line x1="6" x2="6" y1="3" y2="15" />
    <circle cx="18" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </svg>
);

export const StoreIcon = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="m2 7 1.6-3.2A2 2 0 0 1 5.39 3h13.22a2 2 0 0 1 1.79 1.1L22 7" />
    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
    <path d="M2 7h20l-1 5a3 3 0 0 1-3 2.4 3 3 0 0 1-3-2.4 3 3 0 0 1-3 2.4 3 3 0 0 1-3-2.4 3 3 0 0 1-3 2.4 3 3 0 0 1-3-2.4Z" />
  </svg>
);

export const StarIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <svg {...base(p)} fill={filled ? "currentColor" : "none"}>
    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
  </svg>
);

// AgentKitForge brand mark — the indigo/cyan 3D forge-cube icon.
// Ported from agentkitforge-app/src/assets/brand/agentkitforge-icon.svg.
// Multi-color brand palette (not currentColor); self-contained, full-bleed.
export const ForgeMark = ({ size = 38, ...props }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 96 96"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role="img"
    aria-label="AgentKitForge"
    {...props}
  >
    <defs>
      <linearGradient id="akf-left" x1="18" y1="45" x2="48" y2="84" gradientUnits="userSpaceOnUse">
        <stop stopColor="#4F46E5" />
        <stop offset="1" stopColor="#3730A3" />
      </linearGradient>
      <linearGradient id="akf-right" x1="76" y1="45" x2="45" y2="84" gradientUnits="userSpaceOnUse">
        <stop stopColor="#6366F1" />
        <stop offset="1" stopColor="#4338CA" />
      </linearGradient>
      <linearGradient id="akf-top" x1="26" y1="18" x2="66" y2="44" gradientUnits="userSpaceOnUse">
        <stop stopColor="#818CF8" />
        <stop offset="1" stopColor="#4F46E5" />
      </linearGradient>
      <linearGradient id="akf-cyan" x1="48" y1="39" x2="48" y2="58" gradientUnits="userSpaceOnUse">
        <stop stopColor="#22D3EE" />
        <stop offset="1" stopColor="#06B6D4" />
      </linearGradient>
    </defs>
    <path d="M18 49.4L47.8 32.4L78 49.4L48 66.8L18 49.4Z" fill="#5B5FEF" />
    <path d="M18 49.4L48 66.8V86.2L18 68.5V49.4Z" fill="url(#akf-left)" />
    <path d="M78 49.4L48 66.8V86.2L78 68.5V49.4Z" fill="url(#akf-right)" />
    <path d="M42.6 42.8H53.4V57.6L48 61.1L42.6 57.6V42.8Z" fill="url(#akf-cyan)" />
    <path d="M38.6 58.8L48 64.4L57.4 58.8L62.8 62L48 70.8L33.2 62L38.6 58.8Z" fill="#CFFAFE" />
    <path d="M30.5 18.6L48 8.6L65.7 18.6L48.1 28.8L30.5 18.6Z" fill="url(#akf-top)" />
    <path d="M30.5 18.6L48.1 28.8V45.3L30.5 35V18.6Z" fill="#4F46E5" />
    <path d="M65.7 18.6L48.1 28.8V45.3L65.7 35V18.6Z" fill="#3730A3" />
  </svg>
);
