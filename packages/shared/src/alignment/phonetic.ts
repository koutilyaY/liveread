/**
 * Compact deterministic phonetic key for Latin-script tokens
 * (metaphone-inspired). Used as ONE weighted signal among several in the
 * alignment score — never as the sole matcher. Non-Latin tokens return ""
 * so the phonetic signal simply contributes nothing for those languages.
 */
export function phoneticKey(word: string): string {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return "";

  let s = w
    .replace(/^kn/, "n")
    .replace(/^gn/, "n")
    .replace(/^wr/, "r")
    .replace(/^ps/, "s")
    .replace(/^wh/, "w")
    .replace(/mb$/, "m");

  s = s
    .replace(/ough/g, "f")
    .replace(/gh(?![aeiou])/g, "")
    .replace(/ph/g, "f")
    .replace(/sh/g, "x")
    .replace(/ch/g, "x")
    .replace(/th/g, "0")
    .replace(/ck/g, "k")
    .replace(/qu/g, "kw")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/dg(?=[eiy])/g, "j")
    .replace(/g(?=[eiy])/g, "j")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/v/g, "f")
    .replace(/d/g, "t")
    .replace(/b/g, "p");

  // keep the leading character (vowel or consonant), drop later vowels
  const head = s[0] ?? "";
  const tail = s.slice(1).replace(/[aeiouyhw]/g, "");
  s = head + tail;
  // collapse repeats
  s = s.replace(/(.)\1+/g, "$1");
  return s;
}

export function phoneticMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ka = phoneticKey(a);
  const kb = phoneticKey(b);
  return ka !== "" && ka === kb;
}
