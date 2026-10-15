"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { DenButton } from "../../app/(den)/_components/ui/button";

// One observer for all deferred sections. Release each target after its first
// intersection and disconnect the observer when the last target is gone.
const pending = new Map<Element, () => void>();
let observer: IntersectionObserver | null = null;

function unobserve(element: Element) {
  observer?.unobserve(element);
  pending.delete(element);
  if (pending.size === 0) {
    observer?.disconnect();
    observer = null;
  }
}

function observe(element: Element, reveal: () => void) {
  if (!("IntersectionObserver" in window)) {
    reveal();
    return () => undefined;
  }
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const revealTarget = pending.get(entry.target);
      unobserve(entry.target);
      revealTarget?.();
    }
  }, { rootMargin: "400px 0px" });
  pending.set(element, reveal);
  observer.observe(element);
  return () => unobserve(element);
}

export function AdminDeferredContent({ children, label, className, placeholderClassName, onVisible }: {
  children: () => ReactNode;
  label: string;
  className?: string;
  placeholderClassName: string;
  onVisible?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (visible || !ref.current) return;
    return observe(ref.current, () => setVisible(true));
  }, [visible]);
  useEffect(() => { if (visible) onVisible?.(); }, [visible, onVisible]);

  return (
    <div ref={ref} className={className} data-admin-deferred={visible ? "ready" : "pending"}>
      {visible ? children() : (
        <div className={`flex items-start rounded-2xl bg-gray-50 p-4 ${placeholderClassName}`}>
          <DenButton variant="ghost" onClick={() => setVisible(true)}>{label}</DenButton>
        </div>
      )}
    </div>
  );
}
