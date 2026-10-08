// Obsidian adds a few DOM helpers to every page (createEl, createDiv, setCssProps, toggleClass, ...).
// The browser preview harness runs outside Obsidian, so it provides small stand-ins for the ones the plugin uses.
interface Info {
  cls?: string | string[];
  text?: string;
  attr?: Record<string, string | number | boolean | null | undefined>;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, o?: Info | string): HTMLElementTagNameMap[K] {
  // this file is what provides createEl in the browser preview, so it builds elements through the namespace-aware API
  const e = document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K];
  const info: Info = typeof o === "string" ? { cls: o } : o ?? {};
  if (info.cls) e.className = Array.isArray(info.cls) ? info.cls.join(" ") : info.cls;
  if (info.text !== undefined) e.textContent = info.text;
  for (const [k, v] of Object.entries(info.attr ?? {})) if (v !== null && v !== undefined) e.setAttribute(k, String(v));
  return e;
}

Object.assign(window, { createEl: make, createDiv: (o?: Info | string) => make("div", o) });

Object.assign(HTMLElement.prototype, {
  createDiv(this: HTMLElement, o?: Info | string) { const e = make("div", o); this.appendChild(e); return e; },
  setCssProps(this: HTMLElement, props: Record<string, string>) { for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v); },
  toggleClass(this: HTMLElement, cls: string, on: boolean) { this.classList.toggle(cls, on); },
});
