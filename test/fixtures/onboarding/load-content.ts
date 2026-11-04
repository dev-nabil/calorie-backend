import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Absolute path of a product content file in this repo (content/onboarding/<name>). */
export function contentPath(name: string): string {
  return resolve(__dirname, '../../../content/onboarding', name);
}

export function loadContentJson(name: string): unknown {
  return JSON.parse(readFileSync(contentPath(name), 'utf8'));
}
