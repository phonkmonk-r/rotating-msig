export const MIN_PASSWORD = 10;

/** Word counts a BIP-39 seed phrase can have. */
const BIP39_LENGTHS = [12, 15, 18, 21, 24];

export interface ProfileForm {
  kind: "seed" | "ledger";
  name: string;
  mnemonic: string;
  safe: string;
  password: string;
  confirm: string;
}

/** Words in a pasted seed phrase, however it is spaced. */
export function seedWordCount(mnemonic: string): number {
  const trimmed = mnemonic.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** Why the Add a profile form cannot be submitted yet; empty when it can. */
export function profileFormProblems(form: ProfileForm): string[] {
  const problems: string[] = [];
  if (form.name.trim() === "") problems.push("name");
  if (form.safe.trim() !== "" && !/^0x[0-9a-fA-F]{40}$/.test(form.safe.trim())) problems.push("safe");
  if (form.kind === "seed") {
    const words = seedWordCount(form.mnemonic);
    if (!BIP39_LENGTHS.includes(words)) problems.push("seed");
    if (form.password.length < MIN_PASSWORD) problems.push("password");
    if (form.password !== form.confirm) problems.push("confirm");
  }
  return problems;
}
