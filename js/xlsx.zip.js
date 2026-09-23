/* xlsx.zip.js - writes a zip container. Enough of one for an .xlsx, no more.

   An .xlsx is a zip of XML parts, so exporting one means writing a zip. This is
   the whole of that: CRC-32, a local header per entry, and a central directory.
   About eighty lines, no dependency, and it works identically from file:// and
   from serve.js because it does not fetch anything or ask the platform for a
   compressor.

   EVERY ENTRY IS STORED, NOT DEFLATED, and that is a deliberate trade. The
   alternative is CompressionStream('deflate-raw'), which is async, absent on
   older engines, and would need a feature check and a fallback that is this
   code anyway. The zip specification has had "stored" since 1989 and Excel,
   LibreOffice, Numbers and every unzip utility read it. The cost is file size:
   an export lands around 250 KB rather than 60 KB. That is a rounding error
   next to the 5 MB takeoff PDFs this shop already emails, and it buys a writer
   with no failure mode. */
(function (root) {
  'use strict';

  /* The standard CRC-32 table, built once. */
  var TABLE = (function () {
    var t = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* Names and XML are both UTF-8. TextEncoder is everywhere this app runs; the
     manual fallback is here because the tests drive this file in jsdom, where
     it is present, and in bare node, where it is too - but a browser without it
     would otherwise write mojibake into part names rather than fail loudly. */
  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    throw new Error('This browser has no TextEncoder, so it cannot write an .xlsx.');
  }

  /* MS-DOS packed date and time, which is what a zip entry carries. Before
     1980 is unrepresentable, so it clamps rather than writing a negative year
     and producing an archive that unzips with a nonsense timestamp. */
  function dosTime(d) {
    var year = Math.max(1980, d.getFullYear());
    return {
      date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
    };
  }

  /* entries: [{ name, data }] where data is a string or a Uint8Array.
     Returns one Uint8Array, ready for a Blob. */
  function write(entries, when) {
    var stamp = dosTime(when || new Date());
    var files = entries.map(function (e) {
      var data = typeof e.data === 'string' ? utf8(e.data) : e.data;
      return { name: utf8(e.name), data: data, crc: crc32(data), offset: 0 };
    });

    // Local header 30 + name + data, then central 46 + name, then the 22-byte
    // end record. Sized up front so there is one allocation and no copying.
    var size = 22;
    files.forEach(function (f) {
      size += 30 + f.name.length + f.data.length + 46 + f.name.length;
    });

    var out = new Uint8Array(size);
    var view = new DataView(out.buffer);
    var p = 0;

    function u32(v) { view.setUint32(p, v, true); p += 4; }
    function u16(v) { view.setUint16(p, v, true); p += 2; }
    function bytes(b) { out.set(b, p); p += b.length; }

    files.forEach(function (f) {
      f.offset = p;
      u32(0x04034b50);
      u16(20);            // version needed: 2.0, which is what stored requires
      u16(0);             // no flags - not encrypted, sizes are known here
      u16(0);             // method 0: stored
      u16(stamp.time); u16(stamp.date);
      u32(f.crc);
      u32(f.data.length); // compressed size == uncompressed size when stored
      u32(f.data.length);
      u16(f.name.length);
      u16(0);             // no extra field
      bytes(f.name);
      bytes(f.data);
    });

    var dirStart = p;
    files.forEach(function (f) {
      u32(0x02014b50);
      u16(20); u16(20);   // made by / needed
      u16(0); u16(0);     // flags, method
      u16(stamp.time); u16(stamp.date);
      u32(f.crc);
      u32(f.data.length); u32(f.data.length);
      u16(f.name.length);
      u16(0); u16(0);     // extra, comment
      u16(0);             // disk number
      u16(0);             // internal attributes
      u32(0);             // external attributes
      u32(f.offset);
      bytes(f.name);
    });

    // Measured before the end record is written, because writing it moves p.
    // Reading it inline reports a directory twelve bytes longer than the one
    // that is there, and every unzip then believes the file is truncated.
    var dirSize = p - dirStart;

    u32(0x06054b50);
    u16(0); u16(0);
    u16(files.length); u16(files.length);
    u32(dirSize);
    u32(dirStart);
    u16(0);               // no archive comment

    return out;
  }

  /* ---- the three primitives every xlsx writer needs ---------------------- */

  /* They started in js/estimate.xlsx.js and live here because there are two
     writers now - the estimate workbook and the bids report - and a second copy
     of "which characters does Excel refuse" is a second place for it to be
     wrong. This file is already the shared low-level end of writing a workbook,
     so they sit beside the zip rather than in either writer. */

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      // Excel rejects the C0 controls outright; a stray tab or newline pasted
      // into a description would otherwise make the whole file unreadable.
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  /* 0 -> A, 25 -> Z, 26 -> AA. */
  function colName(i) {
    var s = '';
    for (i = i + 1; i > 0; i = Math.floor((i - 1) / 26)) {
      s = String.fromCharCode(65 + (i - 1) % 26) + s;
    }
    return s;
  }

  /* Float dust: 45292.30150000001 is the same money as 45292.3015 and one of
     them makes the sheet look broken. Ten places is far past the cent and well
     inside a double's honest precision. */
  function num(v) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.round(n * 1e10) / 1e10;
  }

  root.Zip = {
    write: write, crc32: crc32,
    esc: esc, colName: colName, num: num
  };
})(typeof window !== 'undefined' ? window : globalThis);
