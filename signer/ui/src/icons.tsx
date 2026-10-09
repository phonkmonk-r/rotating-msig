import type { SVGProps } from "react";

/** Stroke icons drawn on a 24px grid. */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export const IconOverview = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Icon>
);

export const IconTransactions = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M7 4v16M7 20l-3-3M7 20l3-3" />
    <path d="M17 20V4M17 4l-3 3M17 4l3 3" />
  </Icon>
);

export const IconSigners = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20c.8-3.5 3.5-5.5 6.5-5.5s5.7 2 6.5 5.5" />
    <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.6.8 2.7 2.6 3 5.2" />
  </Icon>
);

export const IconSettings = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Icon>
);

export const IconLock = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Icon>
);

export const IconRefresh = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 0 0-14.6-4.5L4 8M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 14.6 4.5L20 16M20 20v-4h-4" />
  </Icon>
);

export const IconCopy = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p} width="14" height="14">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </Icon>
);

export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);

export const IconAlert = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 3l9.5 17h-19L12 3z" />
    <path d="M12 10v4M12 17.5v.01" />
  </Icon>
);

export const IconExternal = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p} width="13" height="13">
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
);

export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p} width="15" height="15" strokeWidth="2.2">
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconGlobe = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
  </Icon>
);

export const IconBack = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M15 18l-6-6 6-6" />
  </Icon>
);

export const IconForward = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M9 18l6-6-6-6" />
  </Icon>
);

export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const IconKey = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="8" cy="12" r="4.5" />
    <path d="M12.5 12h8.5M18 12v3M21 12v2.5" />
  </Icon>
);

export const IconInbox = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p} width="28" height="28" strokeWidth="1.5">
    <path d="M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" />
    <path d="M3 13h5l1.5 2.5h5L16 13h5" />
  </Icon>
);

/** The Cicada mark: the cicada from the app icon, with its wings folded over the body. */
export const Logo = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="64 64 896 896" aria-hidden="true">
    <rect x="64" y="64" width="896" height="896" rx="200" fill="#0f403a" />
    <g transform="translate(512 528) scale(1.04) translate(-512 -585)">
      <path d="M422 416 C408 560 450 720 512 812 C574 720 616 560 602 416 Z" fill="#e8b445" />
      <path d="M438 512 Q512 540 586 512 M450 592 Q512 616 574 592 M466 668 Q512 688 558 668" fill="none" stroke="#06201e" strokeOpacity="0.45" strokeWidth="16" strokeLinecap="round" />
      <path d="M494 430 C372 462 318 640 356 822 C370 886 414 912 446 898 C484 806 506 640 516 472 Z" fill="#f2faf6" fillOpacity="0.82" />
      <path d="M530 430 C652 462 706 640 668 822 C654 886 610 912 578 898 C540 806 518 640 508 472 Z" fill="#f2faf6" fillOpacity="0.82" />
      <path d="M470 466 C392 560 362 700 378 850 M554 466 C632 560 662 700 646 850" fill="none" stroke="#0b3b36" strokeOpacity="0.26" strokeWidth="12" strokeLinecap="round" />
      <ellipse cx="512" cy="406" rx="108" ry="78" fill="#efc25a" />
      <ellipse cx="512" cy="314" rx="86" ry="62" fill="#f4cd68" />
      <circle cx="440" cy="310" r="27" fill="#06201e" />
      <circle cx="584" cy="310" r="27" fill="#06201e" />
    </g>
  </svg>
);
