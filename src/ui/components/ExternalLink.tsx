import type { ComponentChildren } from 'preact';

/** Link opening a new window, announced to assistive technologies (RGAA 13.2). */
export function ExternalLink({ href, class: className, children }: { href: string; class?: string; children: ComponentChildren }) {
  return (
    <a class={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span class="visually-hidden"> (nouvelle fenêtre)</span>
    </a>
  );
}
