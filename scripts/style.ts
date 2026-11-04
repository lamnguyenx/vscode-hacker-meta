/**
 * The terminal palette the repo scripts share: one ANSI style per function.
 *
 * Colour is opt-out, not opt-in: it is on when stdout is a TTY and `NO_COLOR`
 * is unset, off when either says otherwise, and `FORCE_COLOR` overrides both
 * (`FORCE_COLOR=0 make info | cat` stays plain).
 */

import { stdout } from 'node:process';

const useColor =
  process.env.FORCE_COLOR !== undefined
    ? process.env.FORCE_COLOR !== '0'
    : Boolean(stdout.isTTY) && process.env.NO_COLOR === undefined;

/** One ANSI style; plain text when stdout is redirected or NO_COLOR is set. */
export function paint(code: string, text: string): string {
  return useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const bold = (text: string): string => paint('1', text);
export const dim = (text: string): string => paint('2', text);
export const italic = (text: string): string => paint('3', text);
export const underline = (text: string): string => paint('4', text);
export const red = (text: string): string => paint('31', text);
export const green = (text: string): string => paint('32', text);
export const yellow = (text: string): string => paint('33', text);
export const blue = (text: string): string => paint('34', text);
export const magenta = (text: string): string => paint('35', text);
export const cyan = (text: string): string => paint('36', text);

/** The key column: quiet, italic, and padded so the values line up. */
export function label(text: string, width = 10): string {
  return dim(italic(text.padEnd(width)));
}
