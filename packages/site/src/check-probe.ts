declare const check: (name: string, ok: unknown, detail?: unknown) => boolean;

const rules: string[] = [];
const keyframes: string[] = [];
const walk = (list: CSSRuleList, where: string): void => {
  for (const rule of Array.from(list)) {
    if (rule instanceof CSSKeyframesRule) {
      if (rule.name.includes("scroll-cue")) keyframes.push(`${where} ${rule.name} ${rule.cssRules.length}`);
      continue;
    }
    if (rule instanceof CSSStyleRule) {
      const style = rule.style;
      const animated = style.getPropertyValue("animation-name") !== "" || style.getPropertyValue("animation-timeline") !== "";
      if (rule.selectorText.includes("scroll-cue") || rule.selectorText.includes("pc-table-wrap") || (animated && rule.selectorText.length < 40)) {
        rules.push(`${where} ${rule.cssText.slice(0, 400)}`);
      }
    }
    if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules, `${where} ${rule.constructor.name}`);
  }
};
const sheets = Array.from(document.styleSheets);
sheets.forEach((sheet, at) => {
  try {
    walk(sheet.cssRules, `sheet${at}`);
  } catch (error) {
    rules.push(`sheet${at} unread ${String(error).slice(0, 80)}`);
  }
});
const box = document.querySelector(".scroll-cue") as HTMLElement | null;
const animated = Array.from(document.querySelectorAll("*")).filter((el) => getComputedStyle(el).animationName !== "none").length;
check("E: sheets and keyframes", false, JSON.stringify({ sheets: sheets.length, keyframes, animatedElements: animated, inlineStyle: box?.getAttribute("style") ?? null, classes: box?.className ?? null }));
rules.slice(0, 14).forEach((text, at) => check(`F${at}`, false, text));

export {};
