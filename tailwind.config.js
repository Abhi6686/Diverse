/* tailwind.config.js - the design system.
 *
 * The app is built by `npm run build:css`, which scans the HTML and every file
 * under js/ for class names and writes assets/tailwind.css. That file is
 * committed, so `node serve.js` on a machine that has never run npm install
 * still gets a styled app.
 *
 * THE ONE RULE THIS IMPOSES. Under the old CDN build every class existed,
 * because it was compiled in the browser on demand. Now only what the scanner
 * can see is shipped, so a class name must appear in the source as a complete
 * literal string. 'bg-' + tone + '-600' produces nothing. js/bids.js already
 * works this way on purpose - see the note above Bids.DECISIONS - and that is
 * now load-bearing rather than tidy.
 *
 * Colours are semantic, not descriptive: bg-surface, not bg-white. What each
 * one resolves to lives in assets/tokens.css, which is also where the dark
 * theme is - so a module never has to know which theme is on.
 */
module.exports = {
  content: [
    './Bid_Proposal_Manager_2026.html',
    './js/**/*.js'
  ],

  /* Class strategy, not media: the theme is a per-person setting stored in the
     database (db.ui.theme), and one of its three values is "follow the system".
     Media strategy could not express the other two. */
  darkMode: 'class',

  theme: {
    extend: {
      colors: {
        canvas:  'rgb(var(--c-canvas) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        raised:  'rgb(var(--c-raised) / <alpha-value>)',
        line: {
          DEFAULT: 'rgb(var(--c-line) / <alpha-value>)',
          strong:  'rgb(var(--c-line-strong) / <alpha-value>)'
        },

        ink: {
          DEFAULT: 'rgb(var(--c-ink) / <alpha-value>)',
          strong:  'rgb(var(--c-ink-strong) / <alpha-value>)'
        },
        muted: 'rgb(var(--c-muted) / <alpha-value>)',
        faint: 'rgb(var(--c-faint) / <alpha-value>)',

        chrome: {
          DEFAULT: 'rgb(var(--c-chrome) / <alpha-value>)',
          soft:    'rgb(var(--c-chrome-soft) / <alpha-value>)',
          ink:     'rgb(var(--c-chrome-ink) / <alpha-value>)'
        },

        /* Each tone is the same four slots, so a component can take a tone name
           and build its classes without knowing which one it was handed:
           bg-{tone} for a solid action, bg-{tone}-soft text-{tone}-ink for a
           quiet one or a badge. */
        brand:   tone('brand'),
        ok:      tone('ok'),
        warn:    tone('warn'),
        danger:  tone('danger'),
        info:    tone('info'),
        neutral: tone('neutral')
      },

      /* Two micro sizes instead of the loose scatter of text-[9px], text-[10px]
         and text-[11px] the app had grown. Anything smaller than 10px is not
         readable on a laptop panel, so 9px folds into 3xs. */
      fontSize: {
        '3xs': ['0.625rem',  { lineHeight: '0.875rem' }],   // 10px - chip, micro-label
        '2xs': ['0.6875rem', { lineHeight: '1rem' }]        // 11px - dense table meta
      },

      boxShadow: {
        card: 'var(--shadow-card)',
        pop:  'var(--shadow-pop)'
      },

      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif']
      }
    }
  },

  /* No safelist, deliberately.
     The classes chosen at runtime all live in data tables - Bids.STATUSES,
     Bids.DECISIONS, PROPOSAL_STYLES - but each is written out in full as a
     string literal in a file the scanner reads, so it finds them there. The
     status-* names those tables also carry are not Tailwind utilities at all;
     they are rules in assets/app.css, which is never scanned or purged.
     A safelist here would generate nothing and hide that. */
  plugins: []
};

/* The four slots every tone has. DEFAULT so bg-brand works with no suffix. */
function tone(name) {
  return {
    DEFAULT: 'rgb(var(--c-' + name + ') / <alpha-value>)',
    hover:   'rgb(var(--c-' + name + '-hover) / <alpha-value>)',
    soft:    'rgb(var(--c-' + name + '-soft) / <alpha-value>)',
    ink:     'rgb(var(--c-' + name + '-ink) / <alpha-value>)'
  };
}
