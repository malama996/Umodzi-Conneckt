'use client';

import { useEffect } from 'react';

export default function ScrollReveals() {
  useEffect(() => {
    if (typeof window.IntersectionObserver !== 'function') return;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const targets = new Map<HTMLElement, HTMLElement>();
    const visibility = new WeakMap<HTMLElement, boolean>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const element = targets.get(entry.target as HTMLElement);
          if (!element) continue;
          visibility.set(element, entry.isIntersecting);
          element.classList.toggle('is-visible', entry.isIntersecting);
        }
      },
      // A height-independent threshold also works for sections taller than a mobile viewport.
      { threshold: 0, rootMargin: '0px 0px -25px 0px' },
    );

    function register(root: ParentNode) {
      for (const boundary of root.querySelectorAll<HTMLElement>('.reveal-boundary')) {
        if (targets.has(boundary)) continue;
        const element = boundary.firstElementChild;
        if (!(element instanceof HTMLElement) || !element.classList.contains('reveal')) continue;
        if (boundary.parentElement?.closest('.reveal-boundary')) continue;
        targets.set(boundary, element);
        visibility.set(element, false);
        if (!motion.matches) {
          element.dataset.revealReady = '';
          // Observe the stationary layout box, not the translated content.
          observer.observe(boundary);
        }
      }
    }

    function syncMotion() {
      observer.disconnect();
      for (const [boundary, element] of targets) {
        visibility.set(element, false);
        element.classList.remove('is-visible');
        if (motion.matches) {
          delete element.dataset.revealReady;
        } else {
          element.dataset.revealReady = '';
          observer.observe(boundary);
        }
      }
    }

    register(document);
    const mutations = new MutationObserver((records) => {
      for (const [boundary, element] of targets) {
        if (!boundary.isConnected || boundary.firstElementChild !== element) {
          observer.unobserve(boundary);
          visibility.delete(element);
          delete element.dataset.revealReady;
          element.classList.remove('is-visible');
          targets.delete(boundary);
        }
      }
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof HTMLElement) {
          const visible = visibility.get(record.target);
          // React may replace className when a result's selection state changes.
          if (visible !== undefined && record.target.classList.contains('is-visible') !== visible) {
            record.target.classList.toggle('is-visible', visible);
          }
        } else if (record.addedNodes.length && record.target instanceof Element) {
          register(record.target.parentElement ?? record.target);
        }
      }
    });
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    motion.addEventListener('change', syncMotion);

    return () => {
      mutations.disconnect();
      observer.disconnect();
      motion.removeEventListener('change', syncMotion);
      for (const element of targets.values()) {
        delete element.dataset.revealReady;
        element.classList.remove('is-visible');
      }
    };
  }, []);

  return null;
}
