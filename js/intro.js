/* intro.js - the mark, welded into existence, on the sign-in page.
 *
 * DiVerse fabricate and install miscellaneous metals. The app already had a
 * welding spark engine behind the banner (js/sparks.js); this points it at the
 * one screen where the company introduces itself, and runs an arc across the
 * logo so the mark is laid down rather than merely displayed.
 *
 * HOW THE "3D" IS DONE, since there is no library here and there is not going
 * to be one: a CSS `perspective` stage with the plate, the mark, the glow and
 * the spark canvas on separate `translateZ` planes. Moving the pointer rotates
 * the stage by a couple of degrees, and the planes separate by parallax because
 * they are at different depths. That is real perspective projection - the
 * browser's - rather than a picture of one.
 *
 * The weld itself is a mask: a hard-edged gradient sweeps left to right across
 * the logo, revealing it. The spark emitter is moved to the same x as the mask
 * edge on every frame, so sparks come off the seam being cut and not from a
 * fixed point. Behind the edge the metal is white-hot and cools to its own
 * colour over about a second.
 *
 * THE RULES IT KEEPS, all three inherited from js/sparks.js and none optional:
 *   - prefers-reduced-motion: reduce gets the finished logo and no animation.
 *   - A hidden tab paints nothing.
 *   - It STOPS. About two and a half seconds, then the rAF loop ends. Nothing
 *     ticks while somebody is typing their password.
 */
(function (root) {
  'use strict';

  var U = root.U;

  var WELD_MS = 1700;         // the arc's travel
  var COOL_MS = 900;          // and how long the metal behind it takes to cool
  var raf = null;
  var startedAt = 0;
  var el = {};                // the pieces, looked up once per run

  function reduced() {
    return root.Sparks ? root.Sparks.reduceMotion()
      : !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ---- the markup -------------------------------------------------------- */

  /* Written here rather than in js/auth.js because it is one thing: the scene,
     its layers and the canvas the engine draws on have to agree about their
     stacking and their size, and splitting that across two files is how they
     stop agreeing. */
  /* THE MARK HAS THICKNESS.

     A logo is a flat PNG, so the depth is built rather than drawn: EXTRUDE
     copies of it are stacked behind the face at increasing translateZ, each a
     shade darker, which is what gives a real edge when the scene rotates. It is
     the browser's own perspective projection doing the work - rotate the stage
     and the side of the letters appears, because there genuinely is one.

     Ten layers is where it stops looking like stripes and starts looking like
     steel; more costs compositing for nothing. */
  var EXTRUDE = 10;

  function html() {
    var layers = '';
    for (var i = 1; i <= EXTRUDE; i++) {
      layers += '<img src="assets/diverse-logo.png" class="intro-layer" alt="" ' +
        'aria-hidden="true" style="--i:' + i + '">';
    }
    return '<div id="introStage" class="intro-stage" aria-label="DiVerse Industrial Solutions">' +
      '<div class="intro-plate"></div>' +
      '<div class="intro-grid"></div>' +
      '<div class="intro-scene" id="introScene">' +
        // The mask that reveals the weld lives on this wrapper, so the face,
        // the extrusion and the heat are all uncovered by the same edge.
        '<div class="intro-markwrap" id="introWrap">' +
          '<div class="intro-extrude">' + layers + '</div>' +
          '<img id="introMark" src="assets/diverse-logo.png" class="intro-mark" ' +
               'alt="DiVerse Industrial Solutions" ' +
               'onerror="this.style.display=\'none\'">' +
          // The same artwork blown out white and fading as it cools: the metal
          // behind the arc, still hot.
          '<img id="introHeat" src="assets/diverse-logo.png" class="intro-heat" ' +
               'alt="" aria-hidden="true">' +
          // A specular highlight travelling across the face, as light does over
          // something with a surface.
          '<span class="intro-gloss" aria-hidden="true"></span>' +
          '<span id="introArc" class="intro-arc"></span>' +
        '</div>' +
        // What the mark is standing on: a flipped, faded copy on the plate.
        '<div class="intro-reflection" aria-hidden="true">' +
          '<img src="assets/diverse-logo.png" alt="">' +
        '</div>' +
        '<canvas id="introSparks" class="intro-sparks" aria-hidden="true"></canvas>' +
      '</div>' +
      '<div id="introWords" class="intro-words">' +
        '<div class="intro-tagline">Trust Through Quality Work</div>' +
        '<div class="intro-sub">Safety is our foundation</div>' +
      '</div>' +
    '</div>';
  }

  /* ---- the run ----------------------------------------------------------- */

  function grab() {
    el.stage = U.$('introStage');
    el.scene = U.$('introScene');
    el.wrap = U.$('introWrap');
    el.mark = U.$('introMark');
    el.heat = U.$('introHeat');
    el.arc = U.$('introArc');
    el.words = U.$('introWords');
    el.canvas = U.$('introSparks');
    return !!(el.stage && el.mark && el.wrap);
  }

  /* A mask that reveals everything left of `x`, with a short soft edge so the
     seam glows rather than ending in a hard line. */
  function revealTo(node, pct) {
    var mask = 'linear-gradient(90deg, #000 0%, #000 ' + pct + '%, ' +
      'rgba(0,0,0,0.35) ' + Math.min(100, pct + 2) + '%, ' +
      'transparent ' + Math.min(100, pct + 5) + '%)';
    node.style.webkitMaskImage = mask;
    node.style.maskImage = mask;
  }

  function settle() {
    // The finished state: the whole mark, no heat, no arc, words up. The
    // is-welded class is also what starts the idle float and the gloss sweep -
    // they belong to the finished object, not to the weld.
    if (el.wrap) { el.wrap.style.maskImage = ''; el.wrap.style.webkitMaskImage = ''; }
    if (el.heat) el.heat.style.opacity = 0;
    if (el.arc) el.arc.style.opacity = 0;
    if (el.words) el.words.classList.add('is-in');
    if (el.stage) el.stage.classList.add('is-welded');
  }

  function frame(now) {
    raf = null;
    if (document.hidden) { finish(); return; }

    var t = now - startedAt;
    var travel = Math.min(1, t / WELD_MS);
    // Ease out at the end of the pass, the way a hand slows as it finishes a run.
    var eased = 1 - Math.pow(1 - travel, 2.2);
    var pct = eased * 100;

    // One mask on the wrapper, so the face, its extrusion and the heat are all
    // uncovered by the same edge rather than three that can drift apart.
    revealTo(el.wrap, pct);

    // The heat behind the arc cools from white through to nothing.
    var cool = Math.max(0, 1 - Math.max(0, t - 300) / (WELD_MS + COOL_MS));
    el.heat.style.opacity = String(0.85 * cool);

    // The arc rides the mask edge, and so does the spark source.
    var rect = el.mark.getBoundingClientRect();
    var wrap = el.stage.getBoundingClientRect();
    var x = (rect.left - wrap.left) + rect.width * eased;
    var y = (rect.top - wrap.top) + rect.height * 0.55;
    if (travel < 1) {
      el.arc.style.opacity = 1;
      el.arc.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' +
        (rect.top - wrap.top).toFixed(1) + 'px,0)';
      el.arc.style.height = rect.height + 'px';
      if (root.Sparks) root.Sparks.weld(x, y, true);
    } else {
      el.arc.style.opacity = 0;
      if (root.Sparks) root.Sparks.stop();
    }

    if (t < WELD_MS + COOL_MS) {
      raf = root.requestAnimationFrame(frame);
    } else {
      finish();
    }
  }

  function finish() {
    if (raf) { root.cancelAnimationFrame(raf); raf = null; }
    if (root.Sparks) root.Sparks.stop();
    settle();
  }

  /* ---- parallax ---------------------------------------------------------- */

  /* Two degrees, no more. The point is that the planes separate as you move,
     not that the logo swings about. Set as CSS variables so the transform
     itself stays in the stylesheet with the rest of the scene. */
  function wireParallax(stage) {
    if (reduced()) return;
    stage.addEventListener('pointermove', function (e) {
      var r = stage.getBoundingClientRect();
      var dx = (e.clientX - r.left) / r.width - 0.5;
      var dy = (e.clientY - r.top) / r.height - 0.5;
      stage.style.setProperty('--tilt-y', (dx * 4).toFixed(2) + 'deg');
      stage.style.setProperty('--tilt-x', (-dy * 3).toFixed(2) + 'deg');
    });
    stage.addEventListener('pointerleave', function () {
      stage.style.setProperty('--tilt-y', '0deg');
      stage.style.setProperty('--tilt-x', '0deg');
    });
  }

  /* ---- public ------------------------------------------------------------ */

  function play() {
    if (!grab()) return;

    // No animation at all, rather than a slower one: the finished mark, and the
    // words already up.
    if (reduced() || !root.Sparks) { settle(); return; }

    /* Nothing to weld along. The arc is positioned from the mark's own
       geometry, so with no layout engine - a test harness, or the image not
       loaded yet - there is no seam to follow and no canvas worth allocating.
       Draw the finished mark and leave it. */
    if (!el.mark.getBoundingClientRect().width) { settle(); return; }

    el.stage.classList.remove('is-welded');
    if (el.words) el.words.classList.remove('is-in');
    el.heat.style.opacity = 0;
    revealTo(el.wrap, 0);

    if (!root.Sparks.attach({ canvas: el.canvas, stage: el.stage, floor: true })) {
      settle();                       // no canvas in this browser
      return;
    }

    // The strike: a burst before the arc starts moving, which is what starting
    // an arc actually looks like.
    var rect = el.mark.getBoundingClientRect();
    var wrap = el.stage.getBoundingClientRect();
    root.Sparks.burst((rect.left - wrap.left), (rect.top - wrap.top) + rect.height * 0.55, 30, 1.35);

    startedAt = root.performance ? root.performance.now() : Date.now();
    if (raf) root.cancelAnimationFrame(raf);
    raf = root.requestAnimationFrame(frame);

    // The words arrive as the metal cools, not with it.
    setTimeout(function () { if (el.words) el.words.classList.add('is-in'); }, WELD_MS - 200);
  }

  /* Called by js/auth.js once the sign-in page is in the DOM. */
  function mount() {
    if (!grab()) return;
    wireParallax(el.stage);
    // Clicking the mark runs it again - the one bit of decoration in this app
    // people will actually want to see twice.
    el.stage.addEventListener('click', function (e) {
      if (e.target.closest('button, a, input')) return;
      play();
    });
    play();
  }

  root.Intro = { html: html, mount: mount, play: play, stop: finish };
})(window);
