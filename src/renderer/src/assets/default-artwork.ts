/**
 * Offline square (1:1) default artwork for DoReMi when a track has no custom,
 * embedded, or folder artwork. Pure local SVG data URI — zero network calls.
 */
const DEFAULT_ARTWORK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <radialGradient id="bg" cx="32%" cy="26%" r="82%">
      <stop offset="0%" stop-color="#352B52"/>
      <stop offset="52%" stop-color="#1A1B25"/>
      <stop offset="100%" stop-color="#0D0E14"/>
    </radialGradient>
    <radialGradient id="disc" cx="35%" cy="30%" r="72%">
      <stop offset="0%" stop-color="#252834"/>
      <stop offset="55%" stop-color="#12141B"/>
      <stop offset="100%" stop-color="#0A0B10"/>
    </radialGradient>
    <linearGradient id="label" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#B097F4"/>
      <stop offset="55%" stop-color="#8A6FD4"/>
      <stop offset="100%" stop-color="#564196"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="184" fill="url(#disc)" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  <circle cx="256" cy="256" r="158" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1.5"/>
  <circle cx="256" cy="256" r="134" fill="none" stroke="rgba(255,255,255,0.05)" stroke-width="1.5"/>
  <circle cx="256" cy="256" r="110" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1.5"/>
  <circle cx="256" cy="256" r="68" fill="url(#label)"/>
  <circle cx="256" cy="256" r="62" fill="none" stroke="rgba(255,255,255,0.28)" stroke-width="1.2"/>
  <circle cx="256" cy="256" r="14" fill="#0D0E14" stroke="rgba(255,255,255,0.38)" stroke-width="2"/>
  <text x="256" y="470" text-anchor="middle" fill="rgba(245,246,248,0.45)" font-family="Segoe UI, system-ui, sans-serif" font-size="22" font-weight="600" letter-spacing="6">DoReMi</text>
</svg>`;

export const DEFAULT_DOREMI_ARTWORK_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  DEFAULT_ARTWORK_SVG,
)}`;
