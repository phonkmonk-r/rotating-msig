import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** How many words the backup check asks for. */
export const CHECKED_WORDS = 3;

/** A fresh 12-word BIP-39 seed phrase from the platform's secure random source. */
export function newSeedPhrase(): string {
  return generateMnemonic(wordlist, 128);
}

/** A uniform random integer in [0, bound) from `crypto.getRandomValues`, without modulo bias. */
function randomBelow(bound: number): number {
  const limit = Math.floor(0x1_0000_0000 / bound) * bound;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0]! < limit) return buffer[0]! % bound;
  }
}

/**
 * Picks the word positions the backup check asks for.
 * @param wordCount Words in the phrase.
 * @param count Positions to pick; capped at `wordCount`.
 * @param random Source of integers in [0, bound); defaults to the secure source.
 * @returns Distinct zero-based positions in ascending order.
 */
export function pickCheckedWords(wordCount: number, count = CHECKED_WORDS, random: (bound: number) => number = randomBelow): number[] {
  const positions = Array.from({ length: wordCount }, (_, i) => i);
  const picked: number[] = [];
  while (picked.length < Math.min(count, wordCount)) picked.push(positions.splice(random(positions.length), 1)[0]!);
  return picked.sort((a, b) => a - b);
}

/**
 * Whether the answers match the phrase at the checked positions, ignoring case and surrounding spaces.
 * @param phrase The generated seed phrase.
 * @param positions Zero-based positions that were asked.
 * @param answers What was typed, keyed by position.
 */
export function checkedWordsMatch(phrase: string, positions: number[], answers: Record<number, string>): boolean {
  const words = phrase.trim().split(/\s+/);
  return positions.every((i) => (answers[i] ?? "").trim().toLowerCase() === words[i]);
}

/** Zero-based positions as the words a person counts, such as "#2, #5 and #9". */
export function positionsLabel(positions: number[]): string {
  const labels = positions.map((i) => `#${i + 1}`);
  return labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}
