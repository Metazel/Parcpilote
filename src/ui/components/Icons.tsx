import type { SVGAttributes } from 'preact';

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 2,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
  focusable: 'false',
} as const;

type P = SVGAttributes<SVGSVGElement>;

export const IconNow = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4" />
    <circle cx="12" cy="12" r="3.5" />
  </svg>
);

export const IconRoute = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="6" cy="5" r="2.5" />
    <circle cx="18" cy="19" r="2.5" />
    <path d="M8.5 5H15a3.5 3.5 0 0 1 0 7H9a3.5 3.5 0 0 0 0 7h6.5" />
  </svg>
);

export const IconList = (p: P) => (
  <svg {...base} {...p}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2" />
  </svg>
);

export const IconMap = (p: P) => (
  <svg {...base} {...p}>
    <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
    <path d="M9 4v14M15 6v14" />
  </svg>
);

export const IconGroup = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <circle cx="17.5" cy="10" r="2.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0M15 20a4.5 4.5 0 0 1 7-3.7" />
  </svg>
);

export const BrandMark = (p: P) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...p}>
    <path d="M4 20V9a8 8 0 0 1 16 0v11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
    <circle cx="12" cy="10" r="3" fill="currentColor" />
  </svg>
);
