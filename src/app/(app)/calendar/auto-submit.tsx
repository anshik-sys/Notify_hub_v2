"use client";

import { useEffect, useRef } from "react";

// Submits the form it sits in whenever a field changes (the layer ticks and the
// colleague picker apply at once). The form keeps a <noscript> button for
// browsers without JavaScript.
export function AutoSubmit() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const form = ref.current?.closest("form");
    if (!form) return;
    const submit = () => form.requestSubmit();
    form.addEventListener("change", submit);
    return () => form.removeEventListener("change", submit);
  }, []);
  return <span ref={ref} hidden />;
}
