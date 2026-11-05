// The banner shown on every page of the public demo. Fixed markup only.

/** Fixed banner markup; `to` only ever comes from code, never from a request. */
export function demoBanner(to: 'admin' | 'guest'): string {
  return `<div class="demo-banner" role="note">
  <p><strong>Demo.</strong> Made-up wedding, no sign-in. Your changes are only visible to you and are deleted after 24 hours.</p>
  <nav aria-label="Demo">
    <a href="/admin">Admin view</a>
    <a href="/GUEST3">A guest who hasn\u2019t replied</a>
    <form method="post" action="/demo/reset?to=${to}"><button type="submit">Reset demo</button></form>
  </nav>
</div>`;
}

export const DEMO_STYLES = '<link rel="stylesheet" href="/css/demo.css" />';
