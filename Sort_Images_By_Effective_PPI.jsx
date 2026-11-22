/**********************************************************************
 * Sort_Images_By_Effective_PPI.jsx
 *
 * Analyzes every raster image (embedded RasterItems + linked
 * PlacedItems that point at a raster file) in the active document,
 * computes each one's EFFECTIVE PPI, and moves it to one of three
 * layers based on that value:
 *
 *      effective PPI >= 300            -> "PRESS READY"
 *      250 <= effective PPI < 300      -> "OKAY-ISH"
 *      effective PPI <  250            -> "SMALL"
 *
 * How effective PPI is computed
 * -----------------------------
 *   effective PPI = native pixels  /  printed size in inches
 *
 *   - Embedded rasters (RasterItem): Illustrator stores the image on a
 *     72-ppi base, so its untransformed bounding box (in points) equals
 *     its pixel count. The effective PPI is therefore 72 / matrixScale.
 *
 *   - Linked images (PlacedItem): the matrix scale alone is NOT enough
 *     because the file's own DPI is already baked into the placed size.
 *     So we read the true pixel dimensions straight out of the file
 *     header (JPEG / PNG / TIFF / GIF / BMP / PSD-PSB are supported)
 *     and divide by the printed content size.
 *
 *   When horizontal and vertical PPI differ (non-uniform scaling), the
 *   SMALLER of the two is used for classification, since the worst axis
 *   is what limits print quality.
 *
 * Notes / caveats
 * ---------------
 *   - Items are MOVED to top-level layers. An image that lives inside a
 *     clipping group will be pulled out of that group, which can change
 *     its appearance (it loses the clip). This is unavoidable if you
 *     truly want every image isolated on its own layer.
 *   - Linked files that are missing, or placed art that is not a raster
 *     (PDF / AI / EPS / SVG), are skipped and listed in the report.
 *   - Layers and groups are temporarily unlocked/shown so items can be
 *     moved; original layer states are restored afterward (the three
 *     target layers are left visible & unlocked).
 *
 * Tested logic against Illustrator's Links-panel PPI readout.
 **********************************************************************/

#target illustrator

(function () {

    // ---- Configuration -------------------------------------------------
    var PRESS_READY_PPI = 300;   // >= this  -> PRESS READY
    var OKAYISH_PPI      = 250;   // >= this (and < PRESS_READY) -> OKAY-ISH
                                  // anything lower -> SMALL
    var WRITE_LOG_FILE   = true;  // write a detailed .txt log to the Desktop
    var RASTER_EXTS = "jpg jpeg jpe png gif bmp tif tiff psd psb"; // sniff fallback

    // --------------------------------------------------------------------
    if (app.documents.length === 0) {
        alert("Open a document first.");
        return;
    }
    var doc = app.activeDocument;

    // ============ binary file reader (seek based, no full reads) ========
    function FR(file) {
        this.f = file;
        this.f.encoding = "BINARY";
        this.f.open("r");
        this.len = this.f.length;
    }
    FR.prototype.bytes = function (offset, n) {
        if (offset < 0 || offset >= this.len) return "";
        this.f.seek(offset, 0); // 0 = from start
        return this.f.read(n);
    };
    FR.prototype.close = function () { try { this.f.close(); } catch (e) {} };

    function be16(s, i) { return (s.charCodeAt(i) << 8) | s.charCodeAt(i + 1); }
    function le16(s, i) { return (s.charCodeAt(i + 1) << 8) | s.charCodeAt(i); }
    function be32(s, i) {
        return (s.charCodeAt(i) * 16777216) + (s.charCodeAt(i + 1) << 16) +
               (s.charCodeAt(i + 2) << 8) + s.charCodeAt(i + 3);
    }
    function le32(s, i) {
        return (s.charCodeAt(i + 3) * 16777216) + (s.charCodeAt(i + 2) << 16) +
               (s.charCodeAt(i + 1) << 8) + s.charCodeAt(i);
    }

    // ---- per-format pixel dimension readers ----------------------------
    function jpegSize(r) {
        var offset = 2;                 // skip SOI (FF D8)
        var guard = 0, max = r.len;
        while (offset < max && guard++ < 100000) {
            var b = r.bytes(offset, 4);
            if (b.length < 2) return null;
            var m0 = b.charCodeAt(0), m1 = b.charCodeAt(1);
            if (m0 !== 0xFF) { offset++; continue; }     // resync on garbage
            if (m1 === 0xFF) { offset++; continue; }      // fill byte
            // markers that carry no length payload
            if (m1 === 0xD8 || m1 === 0xD9 || m1 === 0x01 ||
                (m1 >= 0xD0 && m1 <= 0xD7)) { offset += 2; continue; }
            if (b.length < 4) return null;
            var len = be16(b, 2);
            // SOF0..SOF15 (excluding DHT C4, JPG C8, DAC CC) carry dimensions
            if (m1 >= 0xC0 && m1 <= 0xCF && m1 !== 0xC4 && m1 !== 0xC8 && m1 !== 0xCC) {
                var sof = r.bytes(offset + 5, 4); // +marker(2)+len(2)+precision(1)
                if (sof.length < 4) return null;
                return { w: be16(sof, 2), h: be16(sof, 0) };
            }
            offset += 2 + len;
        }
        return null;
    }

    function tiffSize(r, bigEndian) {
        var head = r.bytes(0, 8);
        if (head.length < 8) return null;
        var magic = bigEndian ? be16(head, 2) : le16(head, 2);
        if (magic !== 42) return null;
        var ifd = bigEndian ? be32(head, 4) : le32(head, 4);
        var cb = r.bytes(ifd, 2);
        if (cb.length < 2) return null;
        var count = bigEndian ? be16(cb, 0) : le16(cb, 0);
        var w = null, h = null;
        for (var i = 0; i < count; i++) {
            var e = r.bytes(ifd + 2 + i * 12, 12);
            if (e.length < 12) break;
            var tag  = bigEndian ? be16(e, 0) : le16(e, 0);
            var type = bigEndian ? be16(e, 2) : le16(e, 2);
            var val;
            if (type === 3) { // SHORT
                val = bigEndian ? be16(e, 8) : le16(e, 8);
            } else {          // LONG and friends
                val = bigEndian ? be32(e, 8) : le32(e, 8);
            }
            if (tag === 0x0100) w = val;
            else if (tag === 0x0101) h = val;
            if (w !== null && h !== null) break;
        }
        if (w !== null && h !== null) return { w: w, h: h };
        return null;
    }

    // Returns {w,h} in pixels, or null if format unknown / unreadable.
    function getImagePixelSize(file) {
        if (!file || !file.exists) return null;
        var r = null;
        try {
            r = new FR(file);
            var sig = r.bytes(0, 30);
            if (sig.length < 4) { r.close(); return null; }
            var size = null;

            if (sig.charCodeAt(0) === 0x89 && sig.substr(1, 3) === "PNG") {           // PNG
                size = { w: be32(sig, 16), h: be32(sig, 20) };
            } else if (sig.substr(0, 3) === "GIF") {                                   // GIF
                size = { w: le16(sig, 6), h: le16(sig, 8) };
            } else if (sig.substr(0, 2) === "BM") {                                    // BMP
                var bh = r.bytes(0, 26);
                size = { w: le32(bh, 18), h: Math.abs(le32(bh, 22)) };
            } else if (sig.substr(0, 4) === "8BPS") {                                  // PSD/PSB
                var ph = r.bytes(0, 26);
                size = { w: be32(ph, 18), h: be32(ph, 14) };
            } else if (sig.charCodeAt(0) === 0xFF && sig.charCodeAt(1) === 0xD8) {      // JPEG
                size = jpegSize(r);
            } else if (sig.substr(0, 2) === "MM") {                                     // TIFF big-endian
                size = tiffSize(r, true);
            } else if (sig.substr(0, 2) === "II") {                                     // TIFF little-endian
                size = tiffSize(r, false);
            }
            r.close();
            if (size && size.w > 0 && size.h > 0) return size;
            return null;
        } catch (e) {
            if (r) r.close();
            return null;
        }
    }

    // ============ geometry helpers ======================================
    function scaleXY(m) {
        return {
            x: Math.sqrt(m.mValueA * m.mValueA + m.mValueB * m.mValueB),
            y: Math.sqrt(m.mValueC * m.mValueC + m.mValueD * m.mValueD)
        };
    }
    function bbWH(bb) { // bb = [left, top, right, bottom]
        return { w: Math.abs(bb[2] - bb[0]), h: Math.abs(bb[1] - bb[3]) };
    }
    function fileExt(file) {
        var n = file.name.toLowerCase();
        var dot = n.lastIndexOf(".");
        return dot >= 0 ? n.substr(dot + 1) : "";
    }
    function looksRaster(ext) {
        return (" " + RASTER_EXTS + " ").indexOf(" " + ext + " ") >= 0;
    }

    // ============ layer lock/visibility management ======================
    var savedStates = [];
    function unlockTree(layers) {
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            savedStates.push({ obj: L, vis: L.visible, lock: L.locked });
            L.visible = true;
            L.locked = false;
            if (L.layers && L.layers.length) unlockTree(L.layers);
        }
    }
    function unlockAncestors(it) {
        var p;
        try { p = it.parent; } catch (e) { return; }
        while (p && p.typename && p.typename !== "Document") {
            try { if (p.locked) p.locked = false; } catch (e1) {}
            try { if (p.visible === false) p.visible = true; } catch (e2) {}
            try { p = p.parent; } catch (e3) { break; }
        }
    }

    function getLayer(name) {
        try { return doc.layers.getByName(name); }
        catch (e) {
            var L = doc.layers.add();
            L.name = name;
            return L;
        }
    }

    // ============ collect target items (snapshot first) =================
    var rasters = [];
    var i;
    for (i = 0; i < doc.rasterItems.length; i++) rasters.push(doc.rasterItems[i]);
    var placed = [];
    for (i = 0; i < doc.placedItems.length; i++) placed.push(doc.placedItems[i]);

    if (rasters.length === 0 && placed.length === 0) {
        alert("No raster images (embedded or linked) were found in this document.");
        return;
    }

    // unlock/show all layers + sublayers so we can move freely
    unlockTree(doc.layers);

    // create / fetch the three destination layers
    var layerPress = getLayer("PRESS READY");
    var layerOk    = getLayer("OKAY-ISH");
    var layerSmall = getLayer("SMALL");
    var targetLayers = [layerPress, layerOk, layerSmall];

    // ============ classification ========================================
    var counts = { press: 0, ok: 0, small: 0 };
    var details = [];   // log lines for processed items
    var skipped = [];   // log lines for skipped items

    function classifyAndMove(item, ppi, label, extraInfo) {
        var dest;
        if (ppi >= PRESS_READY_PPI)      { dest = layerPress; counts.press++; }
        else if (ppi >= OKAYISH_PPI)     { dest = layerOk;    counts.ok++;    }
        else                             { dest = layerSmall; counts.small++; }

        unlockAncestors(item);
        try { item.locked = false; } catch (e) {}
        try { if (item.hidden) item.hidden = false; } catch (e) {}

        try {
            item.move(dest, ElementPlacement.PLACEATBEGINNING);
        } catch (eMove) {
            skipped.push(label + "  ->  could not move (" + eMove + ")");
            return;
        }
        details.push(label + "  ->  " + dest.name +
                     "  [" + Math.round(ppi * 10) / 10 + " ppi]  " + extraInfo);
    }

    function nameOf(item, fallback) {
        try { if (item.name && item.name !== "") return item.name; } catch (e) {}
        return fallback;
    }

    // ---- embedded rasters ----------------------------------------------
    for (i = 0; i < rasters.length; i++) {
        var ri = rasters[i];
        var label = "Embedded raster #" + (i + 1) + " (" + nameOf(ri, "<unnamed>") + ")";
        try {
            var s = scaleXY(ri.matrix);
            if (s.x <= 0 || s.y <= 0) { skipped.push(label + "  ->  zero scale"); continue; }
            var ppiH = 72.0 / s.x;
            var ppiV = 72.0 / s.y;
            var ppi  = Math.min(ppiH, ppiV);

            var nb = bbWH(ri.boundingBox);              // pixels (72-ppi base)
            var pxInfo = Math.round(nb.w) + "x" + Math.round(nb.h) + "px";
            var ppiInfo = (Math.round(ppiH) === Math.round(ppiV))
                          ? pxInfo
                          : pxInfo + "  (" + Math.round(ppiH) + "/" + Math.round(ppiV) + " ppi h/v)";

            classifyAndMove(ri, ppi, label, ppiInfo);
        } catch (e) {
            skipped.push(label + "  ->  error: " + e);
        }
    }

    // ---- linked / placed images ----------------------------------------
    for (i = 0; i < placed.length; i++) {
        var pi = placed[i];
        var label = "Linked/placed #" + (i + 1) + " (" + nameOf(pi, "<unnamed>") + ")";
        try {
            var lf = null;
            try { lf = pi.file; } catch (eNoFile) { lf = null; }

            if (!lf) {
                skipped.push(label + "  ->  no external file (embedded/unsupported placed art)");
                continue;
            }
            if (!lf.exists) {
                skipped.push(label + "  ->  linked file MISSING: " + lf.fsName);
                continue;
            }

            var px = getImagePixelSize(lf);
            if (!px) {
                var ext = fileExt(lf);
                if (!looksRaster(ext)) {
                    skipped.push(label + "  ->  not a raster image (." + ext + ")");
                } else {
                    skipped.push(label + "  ->  could not read pixel size from " + lf.name);
                }
                continue;
            }

            var sp = scaleXY(pi.matrix);
            var nbp = bbWH(pi.boundingBox);             // native placed size in points
            if (nbp.w <= 0 || nbp.h <= 0 || sp.x <= 0 || sp.y <= 0) {
                skipped.push(label + "  ->  degenerate geometry");
                continue;
            }

            var dispWpt = nbp.w * sp.x;                 // printed content width (pt)
            var dispHpt = nbp.h * sp.y;                 // printed content height (pt)
            var pPpiH = px.w * 72.0 / dispWpt;
            var pPpiV = px.h * 72.0 / dispHpt;
            var pPpi  = Math.min(pPpiH, pPpiV);

            var info = px.w + "x" + px.h + "px";
            if (Math.round(pPpiH) !== Math.round(pPpiV)) {
                info += "  (" + Math.round(pPpiH) + "/" + Math.round(pPpiV) + " ppi h/v)";
            }
            info += "  [" + lf.name + "]";

            classifyAndMove(pi, pPpi, label, info);
        } catch (e) {
            skipped.push(label + "  ->  error: " + e);
        }
    }

    // ============ restore original layer states =========================
    function isTarget(obj) {
        for (var t = 0; t < targetLayers.length; t++) if (targetLayers[t] === obj) return true;
        return false;
    }
    for (i = 0; i < savedStates.length; i++) {
        var st = savedStates[i];
        if (isTarget(st.obj)) continue;             // keep destination layers visible/unlocked
        try { st.obj.visible = st.vis; } catch (e) {}
        try { st.obj.locked = st.lock; } catch (e) {}
    }

    // ============ report ================================================
    var total = counts.press + counts.ok + counts.small;
    var summary =
        "Done. Sorted " + total + " raster image(s):\n\n" +
        "  PRESS READY (\u2265" + PRESS_READY_PPI + "):   " + counts.press + "\n" +
        "  OKAY-ISH (" + OKAYISH_PPI + "\u2013" + (PRESS_READY_PPI - 1) + "):     " + counts.ok + "\n" +
        "  SMALL (<" + OKAYISH_PPI + "):           " + counts.small + "\n";
    if (skipped.length) summary += "\n  Skipped / unreadable:   " + skipped.length;

    if (WRITE_LOG_FILE) {
        try {
            var log = new File(Folder.desktop + "/PPI_sort_report.txt");
            log.encoding = "UTF-8";
            log.open("w");
            log.writeln("Effective-PPI sort report  \u2014  " + new Date());
            log.writeln("Document: " + doc.name);
            log.writeln("Thresholds:  PRESS READY \u2265 " + PRESS_READY_PPI +
                        " ppi,  OKAY-ISH " + OKAYISH_PPI + "\u2013" + (PRESS_READY_PPI - 1) +
                        " ppi,  SMALL < " + OKAYISH_PPI + " ppi");
            log.writeln("Classification uses the lower of horizontal/vertical PPI.");
            log.writeln("");
            log.writeln("=== SORTED (" + total + ") ===");
            for (i = 0; i < details.length; i++) log.writeln(details[i]);
            log.writeln("");
            log.writeln("=== SKIPPED (" + skipped.length + ") ===");
            for (i = 0; i < skipped.length; i++) log.writeln(skipped[i]);
            log.close();
            summary += "\n\nDetailed log written to:\n" + log.fsName;
        } catch (eLog) {
            summary += "\n\n(Could not write log file: " + eLog + ")";
        }
    }

    app.redraw();
    alert(summary);

})();
