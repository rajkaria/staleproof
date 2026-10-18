/**
 * Upstream docs PRs for the Drift Hall, one per repository with confirmed drift. Drafts live in
 * .ocean/drift-hall/patches/<owner>__<name>.{patch,md} (local); Raj opens them himself. When one is opened or
 * merged, set its status and url here and run scripts/drift-hall/build.ts again.
 */
import type { PrStatus } from './schema.js';

export const PRS: Record<string, { status: PrStatus; title: string; url?: string }> = {};
