/* proposal.paginate.js - flowing the proposal into real pages.
 *
 * The printed proposal carries a running header and a "Page 3" on every sheet.
 * A browser cannot do that on its own: `counter(page)` only exists inside
 * `@page` margin boxes, which Chrome does not implement, and a `position:fixed`
 * element repeats on every page but has no idea which page it is on.
 *
 * So the document is measured and dealt into pages here, the way a typesetter
 * would. Each page is a real 8.5x11in element that knows its own number, which
 * means the preview on screen is exactly what comes out of the printer - the
 * same pages, broken in the same places - rather than a long strip the browser
 * chops up wherever it likes.
 *
 * No dependency. Measuring is done against the live stylesheet, by putting a
 * hidden page inside the same host, so what is measured is what is rendered.
 *
 * The contract with the caller is a list of blocks:
 *
 *   { html }                  an indivisible lump - a card, a heading, a total
 *   { html, splitAt: 'li' }   a list that may be broken between its items
 *   { html, keepWithNext }    never the last thing on a page
 *
 * Measuring and dealing are separate on purpose. Measuring needs a layout
 * engine; dealing is arithmetic, and it is the half with the interesting
 * mistakes in it - so it is testable on its own by passing `measurer`.
 */
(function (root) {
  'use strict';

  function el(html) {
    var d = document.createElement('div');
    d.innerHTML = html;
    return d.firstElementChild;
  }

  /* ---- measuring --------------------------------------------------------- */

  /* A hidden page, inside the host, so the cascade that styles the real pages
     styles this one identically. Two of them: page one has no running header
     and therefore more room than the rest. */
  function domMeasurer(host, pageClass, headerHTML) {
    function probe(head, extra) {
      var page = el('<div class="' + pageClass + ' doc-probe ' + (extra || '') + '">' +
        '<div class="doc-head">' + head + '</div>' +
        '<div class="doc-body"></div>' +
        '<div class="doc-foot">&nbsp;</div></div>');
      host.appendChild(page);
      return page;
    }

    /* Two questions, two probes, because they cannot be asked of the same
       element. How much room a page has is a property of a page at its real
       fixed height. How tall a block is has to be asked of something free to
       grow: scrollHeight never reports less than clientHeight, so inside a page
       of fixed height every block shorter than a full sheet would measure as a
       full sheet. */
    var firstPage = probe('');
    var restPage = probe(headerHTML || '');
    var rule = probe('', 'doc-measure');
    var measureBody = rule.querySelector('.doc-body');

    /* Cumulative: a block's rendered height can depend on its neighbours, and
       this is the sequence those neighbours will be in. `into` is where the
       nodes go - the body for blocks, the list itself for list items, so each
       is measured inside the wrapping it will be printed in - while the growth
       is always read off the measuring body. */
    function heightsOf(into, nodes) {
      var used = contentHeight();
      return nodes.map(function (node) {
        into.appendChild(node);
        var now = contentHeight();
        var h = now - used;
        used = now;
        return h;
      });
    }

    /* Fractional, not scrollHeight. scrollHeight rounds to whole pixels, and
       rounding a hundred blocks each a fraction short adds up to a line of text
       by the foot of a long page - which lands as content hanging over the edge
       of the sheet. The measuring page has no fixed height, so its own box is
       exactly its content. */
    function contentHeight() {
      return measureBody.getBoundingClientRect().height;
    }

    /* A pixel held back. The measuring page and a real page are laid out
       separately, and flex can round them differently; a block that fits by a
       hundredth of a pixel in one may not in the other, and the failure shows
       up as a line of text sliced off at the foot of the sheet. */
    var SLACK = 1;

    return {
      firstFit: firstPage.querySelector('.doc-body').clientHeight - SLACK,
      restFit: restPage.querySelector('.doc-body').clientHeight - SLACK,

      blockHeights: function (blocks) {
        measureBody.innerHTML = '';
        var nodes = blocks.map(function (b) { return el(b.html); });
        var heights = heightsOf(measureBody, nodes.filter(Boolean));
        var i = 0;
        return nodes.map(function (n) { return n ? heights[i++] : 0; });
      },

      /* One list, taken apart: what its wrapping costs, and what each item
         adds. The caller reassembles the runs through mount(). */
      listParts: function (html) {
        var found = findList(el(html));
        if (!found) return null;
        var items = Array.prototype.slice.call(found.list.children);
        if (items.length < 2) return null;      // nothing to break between

        measureBody.innerHTML = '';
        var shell = found.mount([]);
        measureBody.appendChild(shell.node);
        // The wrapping's own padding and leading, charged to every run rather
        // than only to the first.
        var overhead = contentHeight();
        var heights = heightsOf(shell.list, items.map(function (item) {
          return item.cloneNode(true);
        }));
        measureBody.innerHTML = '';
        return { mount: found.mount, items: items, heights: heights, overhead: overhead };
      },

      done: function () {
        [firstPage, restPage, rule].forEach(function (p) { host.removeChild(p); });
      }
    };
  }

  /* The list inside a block, and a way to rebuild the block around any subset
     of its items.

     A block is rarely a bare <ul>: the terms section is a styled wrapper around
     one, and a continuation run has to keep that wrapper or it loses the
     styling and the indentation halfway down the page. So the chain of elements
     from the block down to the list is cloned shallow around every run.

     Only a block whose content is that single chain can be split. One holding a
     paragraph beside the list would lose the paragraph on the second run, so it
     is left whole and moved to the next page instead - which is correct, just
     less tidy. */
  function findList(rootEl) {
    if (!rootEl) return null;

    var chain = [];
    var node = rootEl;
    while (node && !/^(UL|OL)$/.test(node.tagName)) {
      // Whitespace between tags is fine; anything else means this block is more
      // than a list and cannot be taken apart.
      var kids = Array.prototype.filter.call(node.childNodes, function (c) {
        return c.nodeType === 1 || (c.nodeType === 3 && c.nodeValue.trim());
      });
      if (kids.length !== 1 || kids[0].nodeType !== 1) return null;
      chain.push(node);
      node = kids[0];
    }
    if (!node) return null;
    var list = node;

    return {
      list: list,
      mount: function (items) {
        var listClone = list.cloneNode(false);
        items.forEach(function (it) { listClone.appendChild(it.cloneNode(true)); });
        var out = listClone;
        for (var i = chain.length - 1; i >= 0; i--) {
          var wrap = chain[i].cloneNode(false);
          wrap.appendChild(out);
          out = wrap;
        }
        return { node: out, list: listClone };
      }
    };
  }

  /* ---- dealing ----------------------------------------------------------- */

  /* Breaks one list into runs of <li> that each fit the space offered. Every
     run is a complete <ul> or <ol>, so the markup stays valid and the bullets
     keep their styling across the break. */
  function splitList(parts, firstFit, fullFit) {
    var out = [];
    var run = [];
    var used = parts.overhead;
    var budget = firstFit;

    function flush() {
      if (!run.length) return;
      out.push({ html: parts.mount(run).node.outerHTML, height: used });
      run = [];
    }

    parts.items.forEach(function (item, i) {
      var h = parts.heights[i];
      // An item taller than a whole page goes on its own and overflows, which
      // is visible and fixable, rather than being silently dropped.
      if (run.length && used + h > budget) {
        flush();
        used = parts.overhead;
        budget = fullFit;
      }
      run.push(item);
      used += h;
    });
    flush();
    return out;
  }

  /* Deals the blocks into pages and returns the finished HTML.

     opts: { host, blocks, pageClass, header(pageNo), footer(pageNo, pageCount),
             measurer }                                  measurer: tests only */
  function flow(opts) {
    var pageClass = opts.pageClass || 'doc-page';
    var header = opts.header || function () { return ''; };
    var footer = opts.footer || function () { return ''; };
    var blocks = opts.blocks || [];

    var m = opts.measurer || domMeasurer(opts.host, pageClass, header(2));
    var heights = m.blockHeights(blocks);

    // Page one's header is the letterhead, which is a block like any other, so
    // it has the full body to itself; every page after it gives up the running
    // header's height.
    var firstFit = m.firstFit;
    var restFit = m.restFit;

    var pages = [[]];
    var used = 0;
    function fit() { return pages.length === 1 ? firstFit : restFit; }
    function page() { return pages[pages.length - 1]; }
    function newPage() { pages.push([]); used = 0; }

    blocks.forEach(function (b, i) {
      var h = heights[i];
      var room = fit() - used;

      if (h <= room) {
        page().push(b.html);
        used += h;
        return;
      }

      if (b.splitAt === 'li') {
        var parts = m.listParts(b.html);
        if (parts) {
          // Not even one item fits in what is left, so do not cram one in and
          // let it hang off the bottom - turn the page and start clean.
          if (room < parts.overhead + parts.heights[0]) {
            newPage();
            room = restFit;
          }
          var runs = splitList(parts, room, restFit);
          runs.forEach(function (run, n) {
            if (n > 0) newPage();
            page().push(run.html);
          });
          // Only the tail run occupies the page that is now current, so what is
          // left of it is genuinely free for whatever comes next.
          used = runs[runs.length - 1].height;
          return;
        }
      }

      newPage();
      page().push(b.html);
      used = h;
    });

    /* A heading must not be left alone at the foot of a page. Done afterwards
       rather than during, because only now is it known what followed it. */
    for (var i = 0; i < pages.length - 1; i++) {
      var last = pages[i][pages[i].length - 1];
      var def = blockFor(blocks, last);
      if (def && def.keepWithNext && pages[i].length > 1) {
        pages[i + 1].unshift(pages[i].pop());
      }
    }

    if (m.done) m.done();

    var count = pages.length;
    return pages.map(function (onPage, n) {
      var no = n + 1;
      return '<div class="' + pageClass + (no === count ? ' doc-page-last' : '') + '">' +
        '<div class="doc-head">' + (no === 1 ? '' : header(no)) + '</div>' +
        '<div class="doc-body">' + onPage.join('') + '</div>' +
        '<div class="doc-foot">' + footer(no, count) + '</div>' +
      '</div>';
    }).join('');
  }

  function blockFor(blocks, html) {
    for (var i = 0; i < blocks.length; i++) if (blocks[i].html === html) return blocks[i];
    return null;
  }

  root.Paginate = { flow: flow, splitList: splitList };
})(window);
