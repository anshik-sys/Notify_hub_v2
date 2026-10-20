"use client";

import { useEffect } from "react";

// Scrolls the hour grid so `id` (07:00, or the hour before now on today) is
// just below its sticky day header, instead of opening at midnight. Only the
// grid scrolls, never the page.
export function ScrollTo({ id }: { id: string }) {
  useEffect(() => {
    const el = document.getElementById(id);
    const box = el?.closest("[data-scroll]");
    if (!el || !(box instanceof HTMLElement)) return;
    const header = box.firstElementChild instanceof HTMLElement && box.firstElementChild.dataset.sticky ? box.firstElementChild.offsetHeight : 0;
    box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - header;
  }, [id]);
  return null;
}
