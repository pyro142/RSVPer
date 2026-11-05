// Which wedding is this request for?
//
// Single-tenant today: always the 'default' wedding. This is the ONE place a
// hosted, multi-couple version would change (e.g. resolve by hostname or
// subdomain). Everything downstream receives a weddingId and never decides
// it for itself. See docs/architecture.md.

import type { Env } from './env';

export const DEFAULT_WEDDING_ID = 'default';

export function resolveWeddingId(_request: Request, _env: Env): string {
  return DEFAULT_WEDDING_ID;
}
