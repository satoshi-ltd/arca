(() => {
  const camel = (name) =>
    name.replace(/(^|-)([a-z0-9])/g, (_, a, b) => b.toUpperCase());
  function mountIcons() {
    document.querySelectorAll("[data-icon]").forEach((el) => {
      const node = window.lucide?.icons[camel(el.dataset.icon)];
      if (!node) return;
      const size = Number(el.dataset.size) || 16;
      const svg = window.lucide.createElement(node);
      for (const [key, value] of Object.entries({
        width: size,
        height: size,
        "stroke-width": 1.75,
        "aria-hidden": "true",
        class: `icon ${el.className}`.trim(),
      }))
        svg.setAttribute(key, String(value));
      el.replaceWith(svg);
    });
  }
  function fillTokens() {
    document.querySelectorAll("[data-token]").forEach((el) => {
      const name = `--${el.dataset.token}`;
      const chip = el.querySelector("i");
      if (chip) chip.style.background = `var(${name})`;
      const value = getComputedStyle(el).getPropertyValue(name).trim();
      const code = el.querySelector("code");
      if (code) code.textContent = value || "unset";
    });
  }
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("arca-design-theme", theme);
    } catch {}
    document.querySelectorAll("[data-kit-theme]").forEach((button) => {
      const active = button.dataset.kitTheme === theme;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    fillTokens();
  }
  let saved = null;
  try {
    saved = localStorage.getItem("arca-design-theme");
  } catch {}
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-kit-theme]");
    if (button) setTheme(button.dataset.kitTheme);
  });
  mountIcons();
  setTheme(
    saved ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
  );
})();
