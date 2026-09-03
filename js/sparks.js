/* sparks.js - welding sparks behind the banner logo, on hover.
 *
 * Decorative only. Three rules it must not break, because this sits on every
 * screen in the app all day:
 *
 *   1. Nothing runs unless the pointer is on the banner. The rAF loop starts on
 *      enter and stops itself once the last particle has died - there is no
 *      idle timer ticking in the background.
 *   2. prefers-reduced-motion: reduce means no animation at all, not a slower
 *      one. The banner is simply still.
 *   3. A hidden tab paints nothing.
 *
 * No dependency; the canvas is aria-hidden and pointer-events:none, so it is
 * invisible to assistive tech and never eats a click.
 */
(function (root) {
  'use strict';

  var MAX = 220;              // hard ceiling on live particles
  var EMIT_PER_FRAME = 5;     // new sparks per frame while hovering
  var GRAVITY = 0.055;
  var DRAG = 0.985;

  var canvas, ctx, stage;
  var particles = [];
  var raf = null;
  var hovering = false;
  var dpr = 1;
  var w = 0, h = 0;

  function reduceMotion() {
    return root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* The drawing context is created on the first hover, not at boot. Nothing
     needs it until then, and a page that is never hovered - or a browser with
     no canvas at all - should not be allocating one. */
  function ensureCtx() {
    if (ctx) return true;
    if (!canvas || !canvas.getContext) return false;
    try { ctx = canvas.getContext('2d'); } catch (e) { ctx = null; }
    return !!ctx;
  }

  function resize() {
    if (!canvas || !stage || !ctx) return;
    var r = stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = Math.min(root.devicePixelRatio || 1, 2);   // 2x is plenty; 3x is waste
    w = r.width; h = r.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* Sparks come off the mark itself, low and to the left, the way they would
     off a bead being run. */
  function origin() {
    return { x: w * 0.10 + Math.random() * w * 0.14, y: h * 0.62 };
  }

  function spawn(n, at, energy) {
    for (var i = 0; i < n && particles.length < MAX; i++) {
      var o = at || origin();
      // Upward-biased cone with a wide spread, so it fans rather than jets.
      var angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.1;
      var speed = (0.9 + Math.random() * 2.6) * (energy || 1);
      particles.push({
        x: o.x, y: o.y,
        vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 0.8,
        vy: Math.sin(angle) * speed,
        life: 1,
        // Short-lived so the trail stays crisp instead of smearing.
        decay: 0.014 + Math.random() * 0.022,
        size: 0.7 + Math.random() * 1.3,
        // A few carry enough charge to burst again - the crackle in a real arc.
        crackle: Math.random() < 0.14 ? 0.35 + Math.random() * 0.25 : 0
      });
    }
  }

  /* White at full heat, through yellow and orange as it cools. */
  function colour(life) {
    if (life > 0.72) return 'rgba(255,255,244,';
    if (life > 0.45) return 'rgba(255,214,120,';
    if (life > 0.2) return 'rgba(255,150,44,';
    return 'rgba(214,74,18,';
  }

  function step() {
    raf = null;
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);
    if (hovering && !document.hidden) spawn(EMIT_PER_FRAME);

    // Additive, so overlapping sparks bloom the way hot metal does.
    ctx.globalCompositeOperation = 'lighter';

    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.vy += GRAVITY;
      p.vx *= DRAG;
      p.vy *= DRAG;
      p.x += p.vx;
      p.y += p.vy;
      p.life -= p.decay;

      if (p.life <= 0 || p.y > h + 12 || p.x < -20 || p.x > w + 20) {
        if (p.crackle && p.life <= 0 && p.y < h) {
          spawn(3 + Math.floor(Math.random() * 3), { x: p.x, y: p.y }, p.crackle);
        }
        particles.splice(i, 1);
        continue;
      }

      var c = colour(p.life);
      // A short streak along the direction of travel reads as motion far better
      // than a dot does at this size.
      ctx.strokeStyle = c + (p.life * 0.9).toFixed(3) + ')';
      ctx.lineWidth = p.size;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 2.1, p.y - p.vy * 2.1);
      ctx.stroke();
    }

    ctx.globalCompositeOperation = 'source-over';

    // Stops itself: no hover and nothing left to draw means no next frame.
    if (hovering || particles.length) raf = root.requestAnimationFrame(step);
    else ctx.clearRect(0, 0, w, h);
  }

  function start() {
    if (raf == null) raf = root.requestAnimationFrame(step);
  }

  function enter() {
    if (reduceMotion() || !ensureCtx()) return;
    hovering = true;
    resize();
    spawn(26, null, 1.25);          // an initial strike, then a steady stream
    start();
  }

  function leave() {
    hovering = false;
    start();                        // let the sparks in flight finish and die
  }

  function init() {
    canvas = document.getElementById('sparkCanvas');
    stage = document.getElementById('bannerStage');
    if (!canvas || !stage) return;

    // pointerenter/leave rather than mouseover: no repeat firing as the pointer
    // crosses the logo and the heading inside the stage.
    stage.addEventListener('pointerenter', enter);
    stage.addEventListener('pointerleave', leave);
    // A touch device has no hover; a tap gives one burst.
    stage.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'mouse' && !reduceMotion() && ensureCtx()) {
        resize(); spawn(34, null, 1.3); start();
      }
    });

    if (typeof root.ResizeObserver === 'function') {
      new root.ResizeObserver(resize).observe(stage);
    } else {
      root.addEventListener('resize', resize);
    }

    // A backgrounded tab already gets throttled rAF, but drop the particles too
    // so returning to it does not show a frozen shower mid-air.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hovering = false; particles.length = 0; }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  root.Sparks = { spawn: spawn, isRunning: function () { return raf != null; } };
})(window);
