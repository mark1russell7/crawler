declare const check: (name: string, ok: unknown, detail?: unknown) => boolean;
declare const until: <T>(fn: () => T | Promise<T>, ms?: number) => Promise<T>;
declare const $: (selector: string) => Element | null;
declare const $$: (selector: string) => Element[];

const box = await until(() => {
  const found = $$(".scroll-cue").filter((el) => el.scrollWidth > el.clientWidth + 1);
  if (found.length === 0) {
    window.scrollBy(0, 600);
    return null;
  }
  return found[0];
}, 20000);

const state = (el: Element) => {
  const style = getComputedStyle(el);
  const animations = (el as HTMLElement).getAnimations();
  return {
    client: el.clientWidth,
    scroll: el.scrollWidth,
    scrollLeft: el.scrollLeft,
    top: Math.round(el.getBoundingClientRect().top),
    supports: CSS.supports("animation-timeline: scroll()"),
    left: style.getPropertyValue("--scroll-cue-fade-left"),
    right: style.getPropertyValue("--scroll-cue-fade-right"),
    size: style.getPropertyValue("--scroll-cue-size"),
    mask: style.getPropertyValue("mask-image").slice(0, 150),
    name: style.getPropertyValue("animation-name"),
    timeline: style.getPropertyValue("animation-timeline"),
    motion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    animations: animations.map((a) => {
      const progress = a.effect?.getComputedTiming().progress;
      return {
        state: a.playState,
        progress,
        current: a.currentTime === null ? null : String(a.currentTime),
        timeline: a.timeline?.constructor.name,
      };
    }),
  };
};

const lastFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
await lastFrame();
check("A: the first box, where the search found it", false, JSON.stringify(state(box as Element)));
(box as Element).scrollIntoView({ block: "center" });
await new Promise((resolve) => setTimeout(resolve, 500));
await lastFrame();
check("B: the box in the viewport", false, JSON.stringify(state(box as Element)));
(box as Element).scrollLeft = 80;
await new Promise((resolve) => setTimeout(resolve, 300));
await lastFrame();
check("C: the box after a scroll of 80 px", false, JSON.stringify(state(box as Element)));
(box as Element).scrollLeft = 0;
window.scrollTo(0, 0);
const count = $$(".scroll-cue").length;
check("D: boxes on the page", false, String(count));
export {};
