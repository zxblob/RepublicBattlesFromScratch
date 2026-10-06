import type { Info } from "./info";

let card: HTMLElement | null = null;
let hideTimer = 0;

function el(): HTMLElement {
  if (!card) {
    card = document.createElement("div");
    card.id = "tip";
    card.className = "hidden";
    document.body.appendChild(card);
  }
  return card;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export function showTip(info: Info, target: HTMLElement, autoHide = 0): void {
  const c = el();
  c.innerHTML =
    `<div class="tip-h"><b>${esc(info.title)}</b>${info.tag ? `<span>${esc(info.tag)}</span>` : ""}</div>` +
    info.lines.map((l) => `<p>${esc(l)}</p>`).join("") +
    (info.cost ? `<div class="tip-c">${esc(info.cost)}</div>` : "") +
    (info.warn ? `<div class="tip-w">${esc(info.warn)}</div>` : "");
  c.classList.remove("hidden");
  const r = target.getBoundingClientRect();
  const w = c.offsetWidth, h = c.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
  let y = r.top - h - 10;
  if (y < 8) y = Math.min(window.innerHeight - h - 8, r.bottom + 10);
  c.style.left = x + "px";
  c.style.top = y + "px";
  window.clearTimeout(hideTimer);
  if (autoHide) hideTimer = window.setTimeout(hideTip, autoHide);
}

export function hideTip(): void {
  window.clearTimeout(hideTimer);
  card?.classList.add("hidden");
}

/**
 * Hover (mouse/pen) shows the info card; on touch a long-press shows it instead of activating the button.
 * `get` is evaluated each time so costs and counts stay current.
 */
export function attachTip(target: HTMLElement, get: () => Info | null): void {
  let press = 0;
  let suppress = false;
  target.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "touch") return;
    const i = get();
    if (i) showTip(i, target);
  });
  target.addEventListener("pointerleave", () => { window.clearTimeout(press); hideTip(); });
  target.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") { hideTip(); return; }
    window.clearTimeout(press);
    press = window.setTimeout(() => {
      const i = get();
      if (i) { showTip(i, target, 5000); suppress = true; navigator.vibrate?.(10); }
    }, 420);
  });
  const cancel = () => window.clearTimeout(press);
  target.addEventListener("pointerup", cancel);
  target.addEventListener("pointercancel", cancel);
  target.addEventListener("pointermove", (e) => { if (e.pointerType === "touch" && Math.abs(e.movementX) + Math.abs(e.movementY) > 6) cancel(); });
  // a long-press must not also trigger the button
  target.addEventListener("click", (e) => {
    if (suppress) { suppress = false; e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
}
