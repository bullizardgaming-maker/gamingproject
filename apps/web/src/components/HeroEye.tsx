import { useEffect, useRef } from 'react';

/**
 * The Bullizard eye, large, for the home hero (CEO, 8 Nov: "our logo, the eye", no dragon). The pupil follows
 * the pointer inside the iris and blinks now and then; it stays still for people who ask for reduced motion.
 */
export function HeroEye({ className }: { className?: string }) {
  const pupil = useRef<SVGGElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    let target = { x: 0, y: 0 };
    const cur = { x: 0, y: 0 };
    const move = (e: PointerEvent) => {
      const r = svg.current?.getBoundingClientRect();
      if (!r) return;
      // Centre of the iris in screen space (viewBox 72×64, iris at 36,41).
      const cx = r.left + (36 / 72) * r.width;
      const cy = r.top + (41 / 64) * r.height;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const d = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, d / 420) * 5.5; // the pupil never leaves the iris
      target = { x: (dx / d) * reach, y: (dy / d) * reach * 0.8 };
    };
    const tick = () => {
      cur.x += (target.x - cur.x) * 0.12;
      cur.y += (target.y - cur.y) * 0.12;
      pupil.current?.setAttribute('transform', `translate(${cur.x.toFixed(2)} ${cur.y.toFixed(2)})`);
      frame = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', move, { passive: true });
    frame = requestAnimationFrame(tick);
    return () => (window.removeEventListener('pointermove', move), cancelAnimationFrame(frame));
  }, []);
  return (
    <svg ref={svg} viewBox="0 0 72 64" className={className} aria-hidden="true" data-testid="hero-eye">
      <defs>
        <radialGradient id="eye-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--eye-glow, #4bae24)" stopOpacity=".55" />
          <stop offset="100%" stopColor="var(--eye-glow, #4bae24)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="36" cy="41" r="30" fill="url(#eye-glow)" className="hero-eye-glow" />
      <path d="M4 8C14 31 58 31 68 8C56 22 16 22 4 8Z" fill="currentColor" className="hero-eye-brow" />
      <circle cx="36" cy="41" r="16" fill="none" stroke="currentColor" strokeWidth="6" />
      <g ref={pupil}>
        <path className="hero-eye-pupil" d="M36 30.5C39.2 35.5 39.2 46.5 36 51.5C32.8 46.5 32.8 35.5 36 30.5Z" />
      </g>
    </svg>
  );
}
