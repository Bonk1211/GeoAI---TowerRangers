import { useEffect, useLayoutEffect, useRef, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMap3D } from '../state/useMap3D';
import { useMapInstance } from '../state/useMapInstance';
import { LandingGlobe } from '../components/LandingGlobe';
import {
  ArrowRightIcon, CalendarIcon, CheckIcon, MapIcon,
  SatelliteIcon, SlidersIcon,
} from '../components/shell/icons';
import './Landing.css';

const capabilities = [
  { number: '01', Icon: SatelliteIcon, title: 'See the bigger picture.', label: 'DETECT',
    description: 'Bring satellite imagery, terrain and environmental signals together to understand the conditions around every tower.',
    detail: 'Geospatial risk intelligence', to: '/map' },
  { number: '02', Icon: SlidersIcon, title: 'Know what matters next.', label: 'DECIDE',
    description: 'Turn risk into a clear maintenance priority. Understand the contributing factors, the intervention and the urgency.',
    detail: 'Explainable maintenance priorities', to: '/investigation' },
  { number: '03', Icon: CalendarIcon, title: 'Put insight into motion.', label: 'DISPATCH',
    description: 'Match work to the right crews. Build practical schedules around travel, capacity and changing conditions.',
    detail: 'Constraint-aware crew scheduling', to: '/schedule' },
];

export function Landing() {
  const navigate = useNavigate();
  const landingRef = useRef<HTMLDivElement>(null);
  const finishCommit = useRef<(() => void) | null>(null);

  // BrowserRouter commits asynchronously. Let the native transition capture
  // the new view only after React has actually replaced this page.
  useLayoutEffect(() => () => finishCommit.current?.(), []);

  useEffect(() => {
    const landing = landingRef.current!;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let drag: { id: number; start: number; y: number; time: number; velocity: number } | null = null;
    let frame = 0;
    let velocity = 0;
    let lastFrame = 0;
    let dragged = false;
    function stop() {
      cancelAnimationFrame(frame);
      const id = drag?.id;
      drag = null;
      if (id !== undefined && landing.hasPointerCapture(id)) landing.releasePointerCapture(id);
      landing.classList.remove('landing-dragging');
    }
    function coast(time: number) {
      const elapsed = Math.min(32, time - lastFrame);
      lastFrame = time;
      velocity *= Math.exp(-elapsed / 220);
      const before = window.scrollY;
      window.scrollBy({ top: velocity * elapsed, behavior: 'instant' });
      if (Math.abs(velocity) > .02 && window.scrollY !== before) frame = requestAnimationFrame(coast);
    }
    function down(event: PointerEvent) {
      stop();
      dragged = false;
      // Touch keeps native momentum; text and controls keep their usual gestures.
      if (event.pointerType !== 'mouse' || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if ((event.target as Element).closest('a, button, input, textarea, select, [contenteditable], [role="button"], [role="link"], p, h1, h2, h3, span, small, label')) return;
      drag = { id: event.pointerId, start: event.clientY, y: event.clientY, time: event.timeStamp, velocity: 0 };
    }
    function move(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.id) return;
      if (!dragged && Math.abs(event.clientY - drag.start) < 5) return;
      if (!dragged) {
        dragged = true;
        landing.setPointerCapture(drag.id);
        landing.classList.add('landing-dragging');
      }
      event.preventDefault();
      const delta = drag.y - event.clientY;
      drag.velocity = Math.max(-3, Math.min(3, delta / Math.max(8, event.timeStamp - drag.time)));
      drag.y = event.clientY;
      drag.time = event.timeStamp;
      window.scrollBy({ top: delta, behavior: 'instant' });
    }
    function up(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.id) return;
      velocity = dragged && event.timeStamp - drag.time < 100 ? drag.velocity : 0;
      stop();
      if (!motion.matches && Math.abs(velocity) > .02) {
        lastFrame = performance.now();
        frame = requestAnimationFrame(coast);
      }
    }
    function cancel() { if (drag) stop(); }
    function click(event: globalThis.MouseEvent) {
      if (!dragged || event.detail === 0) return;
      dragged = false;
      event.preventDefault();
      event.stopPropagation();
    }
    landing.addEventListener('pointerdown', down);
    landing.addEventListener('pointermove', move);
    landing.addEventListener('pointerup', up);
    landing.addEventListener('pointercancel', cancel);
    landing.addEventListener('lostpointercapture', cancel);
    landing.addEventListener('click', click, true);
    window.addEventListener('wheel', stop, { passive: true });
    window.addEventListener('keydown', stop);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', stop);
    motion.addEventListener('change', stop);
    return () => {
      stop();
      landing.removeEventListener('pointerdown', down);
      landing.removeEventListener('pointermove', move);
      landing.removeEventListener('pointerup', up);
      landing.removeEventListener('pointercancel', cancel);
      landing.removeEventListener('lostpointercapture', cancel);
      landing.removeEventListener('click', click, true);
      window.removeEventListener('wheel', stop);
      window.removeEventListener('keydown', stop);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', stop);
      motion.removeEventListener('change', stop);
    };
  }, []);

  function explorePlatform(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    useMap3D.getState().setEnabled(false);
    if (!document.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    event.preventDefault();
    const root = document.documentElement;
    if (root.classList.contains('entering-platform')) return;
    root.classList.add('entering-platform');
    const transition = document.startViewTransition(() => new Promise<void>((resolve) => {
      finishCommit.current = resolve;
      navigate('/map');
      window.scrollTo(0, 0);
    }));
    void transition.ready.then(() => {
      let map = useMapInstance.getState().map;
      const animations = document.getAnimations().filter((animation) =>
        animation instanceof CSSAnimation && ['landing-earth-dive', 'landing-map-emerge'].includes(animation.animationName),
      );
      // Keep the enlarged globe visible while the basemap loads. A failed or
      // slow provider must still reveal the map's own loading/error controls.
      const hold = window.setTimeout(() => {
        for (const animation of animations) {
          animation.pause();
          animation.currentTime = 850;
        }
      }, 850);
      const timeout = window.setTimeout(resume, 6000);
      // The map's passive effect can mount after the transition is ready.
      const unsubscribe = useMapInstance.subscribe((state) => {
        if (!state.map && window.location.pathname !== '/map') resume();
        if (state.map && state.map !== map) {
          map = state.map;
          watchMap();
        }
      });
      function resume() {
        window.clearTimeout(hold);
        window.clearTimeout(timeout);
        unsubscribe();
        map?.off('load', resume);
        map?.off('error', resume);
        for (const animation of animations) if (animation.playState === 'paused') animation.play();
      }
      function watchMap() {
        if (!map) return;
        map.once('load', resume);
        map.once('error', resume);
        if (map.isStyleLoaded()) resume();
      }
      watchMap();
      void transition.finished.then(resume, resume);
    }, () => { /* A skipped transition still navigates normally. */ });
    const cleanup = () => root.classList.remove('entering-platform');
    void transition.finished.then(cleanup, cleanup);
  }

  return (
    <div className="landing" id="top" ref={landingRef}>
      <LandingGlobe />
      <a className="landing-skip" href="#main">Skip to content</a>
      <header className="landing-header">
        <a className="landing-brand" href="#top" aria-label="TowerRangers home">
          <img src="/brand/mcmc-logo.png" alt="MCMC" width="52" height="52" />
          <span className="landing-brand-divider" />
          <span className="landing-wordmark">Tower<span>Rangers</span><small>INFRASTRUCTURE INTELLIGENCE</small></span>
        </a>
        <nav className="landing-nav" aria-label="Main navigation">
          <a href="#platform">The platform</a>
          <a href="#how-it-works">How it works</a>
          <a href="#about">Our mission</a>
        </nav>
        <Link className="landing-button landing-button-small" to="/map">Open platform <ArrowRightIcon size={16} /></Link>
      </header>

      <main id="main">
        <section className="landing-hero" aria-labelledby="hero-title">
          <div className="landing-orbit landing-orbit-outer" aria-hidden="true" />
          <div className="landing-orbit landing-orbit-inner" aria-hidden="true" />

          <div className="landing-hero-topline">
            <span><span className="landing-status-dot" /> A NEW PERSPECTIVE ON CONNECTIVITY</span>
            <span className="landing-edition">MALAYSIA · ASEAN GEOAI 2026</span>
          </div>

          <div className="landing-signal landing-signal-satellite" aria-hidden="true">
            <span className="landing-signal-icon"><SatelliteIcon size={23} /></span>
            <span>Intelligence from above<small>Satellite-powered insight</small></span>
          </div>
          <div className="landing-signal landing-signal-site" aria-hidden="true">
            <span className="landing-signal-icon"><MapIcon size={22} /></span>
            <span>Impact on the ground<small>Site-level decisions</small></span>
          </div>

          <div className="landing-hero-copy">
            <p className="landing-eyebrow">CONNECTED INFRASTRUCTURE. COLLECTIVE RESILIENCE.</p>
            <h1 id="hero-title">Tower<span>Rangers</span><span className="landing-title-period">.</span></h1>
            <h2>Stronger towers.<br />A more connected ASEAN.</h2>
            <p className="landing-hero-description">From a view of the Earth to the next crew on the ground.<br className="landing-desktop-break" /> Geospatial intelligence that turns tower risk into action.</p>
            <div className="landing-hero-actions">
              <Link className="landing-button" to="/map" onClick={explorePlatform}>Explore the platform <ArrowRightIcon size={18} /></Link>
              <Link className="landing-button landing-button-secondary" to="/simulation"><span className="landing-play" aria-hidden="true">▷</span> See it in action</Link>
            </div>
          </div>

          <div className="landing-hero-foot">
            <p>Built for the people<br /><strong>who keep us connected.</strong></p>
            <a href="#platform" className="landing-scroll"><span className="landing-scroll-label">Scroll to explore ASEAN</span><span className="landing-scroll-arrow" aria-hidden="true">↓</span></a>
            <p className="landing-hero-foot-right">FROM ORBIT TO ACTION<span>Detect <i /> Decide <i /> Dispatch</span></p>
          </div>
        </section>

        <section className="landing-context" aria-label="Project context">
          <span className="landing-context-intro">A wider view.<br /><strong>A clearer decision.</strong></span>
          <span><SatelliteIcon size={20} /> Open geospatial data</span>
          <span><SlidersIcon size={20} /> Explainable intelligence</span>
          <span><CalendarIcon size={20} /> Actionable maintenance</span>
          <span className="landing-context-country">MADE FOR<br /><strong>MALAYSIA</strong></span>
        </section>

        <section className="landing-platform landing-section" id="platform" aria-labelledby="platform-title">
          <div className="landing-section-heading">
            <div><p className="landing-eyebrow"><span className="landing-section-tick" /> THE PLATFORM</p><h2 id="platform-title">A world of signals.<br /><span>One clear course of action.</span></h2></div>
            <p>Connect the dots between environmental risk and field operations. Give every maintenance decision a reason — and a next step.</p>
          </div>
          <div className="landing-capabilities" id="how-it-works">
            {capabilities.map(({ number, Icon, title, label, description, detail, to }) => (
              <article className="landing-capability" key={number}>
                <div className="landing-capability-top"><span className="landing-capability-icon"><Icon size={26} /></span><span className="landing-step">{number} / {label}</span></div>
                <h3>{title}</h3>
                <p>{description}</p>
                <Link to={to}>{detail}<ArrowRightIcon size={18} /></Link>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-mission landing-section" id="about" aria-labelledby="mission-title">
          <div className="landing-mission-label"><p className="landing-eyebrow"><span className="landing-section-tick" /> OUR MISSION</p><span>Better decisions.<br />Stronger connections.</span></div>
          <div className="landing-mission-copy"><h2 id="mission-title">Behind every tower,<br />there’s a community.</h2><p>A connection to family. A business opening its doors. A call that needs to get through. TowerRangers helps maintenance teams focus their efforts where they matter, supporting more resilient telecommunications infrastructure across Malaysia.</p><div className="landing-mission-principles"><span><CheckIcon size={17} /> Understand the risk</span><span><CheckIcon size={17} /> Prioritise with purpose</span><span><CheckIcon size={17} /> Act with confidence</span></div></div>
        </section>

        <section className="landing-cta" aria-labelledby="cta-title">
          <div><p className="landing-eyebrow">THE NEXT STEP STARTS WITH A CLEARER VIEW.</p><h2 id="cta-title">See your network differently.</h2></div>
          <Link className="landing-button landing-button-light" to="/map">Enter TowerRangers <ArrowRightIcon size={19} /></Link>
        </section>
      </main>

      <footer className="landing-footer">
        <a className="landing-footer-brand" href="#top"><img src="/brand/mcmc-logo.png" alt="MCMC" width="36" height="36" /><span>TowerRangers</span></a>
        <p>Team TowerRangers <span>·</span> ASEAN GeoAI Fusion 2026<small className="landing-globe-credit">Globe data: <a href="https://www.naturalearthdata.com/about/terms-of-use/">Natural Earth</a> · <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Tilezen</a></small></p>
        <a href="#top">Back to top <span aria-hidden="true">↑</span></a>
      </footer>
    </div>
  );
}
