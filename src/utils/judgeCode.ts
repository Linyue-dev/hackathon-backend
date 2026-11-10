import { randomInt } from "node:crypto";

// No look-alike characters: 0/O, 1/l/I
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const CODE_LENGTH = 8;

/**
 * A random code of 8 letters and digits with at least one digit, so it passes
 * the password rules. It is used as the judge's password.
 */
export function generateJudgeCode(): string {
  const all = LETTERS + DIGITS;
  const chars = Array.from(
    { length: CODE_LENGTH },
    () => all[randomInt(all.length)],
  );
  chars[randomInt(CODE_LENGTH)] = DIGITS[randomInt(DIGITS.length)];
  return chars.join("");
}
