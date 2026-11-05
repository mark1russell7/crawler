declare const check: (name: string, ok: unknown, detail?: unknown) => boolean;

// This probe reads the text of each served sheet, because the rules of the browser hold no animation for the cue.
const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]')) as HTMLLinkElement[];
const hits: string[] = [];
for (const link of links) {
  const text = await (await fetch(link.href)).text();
  const name = link.href.split("/").pop() ?? "";
  const timeline = text.split("animation-timeline").length - 1;
  const fades = text.split("scroll-cue-fades").length - 1;
  hits.push(`${name} length ${text.length}, animation-timeline ${timeline}, scroll-cue-fades ${fades}`);
  let from = 0;
  for (let round = 0; round < 3; round++) {
    const at = text.indexOf("@supports", from);
    if (at < 0) break;
    from = at + 9;
    if (text.slice(at, at + 400).includes("scroll-cue")) hits.push(`${name} at ${at}: ${text.slice(at, at + 420)}`);
  }
  const key = text.indexOf("scroll-cue-fades");
  if (key >= 0) hits.push(`${name} first fades at ${key}: ${text.slice(Math.max(0, key - 240), key + 200)}`);
}
hits.slice(0, 14).forEach((text, at) => check(`G${at}`, false, text));

export {};
