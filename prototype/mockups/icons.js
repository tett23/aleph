document.querySelectorAll("[data-i]").forEach((el) => {
  el.classList.add("i");
  el.style.setProperty("--src", `url(../node_modules/lucide-static/icons/${el.dataset.i}.svg)`);
});
