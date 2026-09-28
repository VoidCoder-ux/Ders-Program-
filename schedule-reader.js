/*
 * Ders Programı Okuyucu — fotoğraftaki haftalık ders programı tablosunu tamamen cihaz üzerinde okur.
 *
 *  1) Görüntü gri tonlamaya çevrilir, eğikliği düzeltilir, gölgeye dayanıklı (yerel) eşikleme yapılır.
 *  2) Tablo çizgileri bulunur: satırlar, sütunlar ve ara çizgisi olmayan birleşik (çok saatlik) hücreler.
 *  3) Başlık hücrelerinden ders saatleri, sol sütundan günler, diğer hücrelerden ders ve öğretmen okunur.
 *
 * Yazı tanıma uygulamayla birlikte gelen Tesseract (vendor/tesseract) ile yapılır.
 * Hiçbir dış servise istek atılmaz, API anahtarı gerekmez, kurulumdan sonra internetsiz de çalışır.
 */
(function (global) {
    'use strict';

    const VENDOR = 'vendor/tesseract/';
    const DAY_NAMES = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
    const DAY_KEYS = [
        ['pazartesi', 'pzt', 'pts', 'pa', 'pt'],
        ['sali', 'sal', 'sa'],
        ['carsamba', 'car', 'crs', 'ca'],
        ['persembe', 'per', 'prs', 'pe'],
        ['cuma', 'cum', 'cu'],
        ['cumartesi', 'cmt', 'cts', 'ct'],
        ['pazar', 'paz', 'pz']
    ];
    // Ders olmayan alt satırlar (imza, sınıf öğretmeni vb.)
    const SKIP_ROW_RE = /^(imza|sinif|ogrt|ogretmen|aciklama|not)/;
    const LETTER_RE = /[A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]/;

    const pad2 = n => String(n).padStart(2, '0');
    const fmtTime = min => `${pad2(Math.floor(min / 60) % 24)}:${pad2(min % 60)}`;
    const median = arr => {
        if (!arr.length) return 0;
        const s = [...arr].sort((a, b) => a - b);
        const m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };

    // ═════════ METİN YARDIMCILARI (saf fonksiyonlar) ═════════

    // "Çarşamba" → "carsamba": OCR'daki Türkçe karakter hatalarına dayanıklı karşılaştırma için
    function fold(text) {
        return String(text || '').toLocaleLowerCase('tr-TR').replace(/̇/g, '')
            .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o')
            .replace(/ş/g, 's').replace(/ü/g, 'u').replace(/[âà]/g, 'a').replace(/[îì]/g, 'i').replace(/[ûù]/g, 'u');
    }

    // "Pa", "pzt", "ÇARŞAMBA", "Cu." → uygulamadaki gün adı
    function normalizeDay(value) {
        const s = fold(value).replace(/[^a-z]/g, '');
        if (!s) return '';
        for (let i = 0; i < DAY_KEYS.length; i++) if (DAY_KEYS[i].includes(s)) return DAY_NAMES[i];
        return '';
    }

    // Gün hücresindeki metinden gün adını bulur; "İmza" gibi satırlar için 'skip' döner
    function dayFromCellText(text) {
        const folded = fold(text).replace(/[^a-z\s]/g, ' ').trim();
        if (SKIP_ROW_RE.test(folded.replace(/\s+/g, ''))) return 'skip';
        for (const tok of folded.split(/\s+/)) {
            const d = normalizeDay(tok);
            if (d) return d;
        }
        return normalizeDay(folded);
    }

    // Metindeki saatleri dakika olarak döndürür: "8.40 - 9.20", "10.35-11.15", "1130-1210", "8:4O"
    function parseTimes(text) {
        const cleaned = String(text || '')
            .replace(/(\d)[oO]/g, (_, d) => d + '0').replace(/[oO](\d)/g, (_, d) => '0' + d)
            .replace(/(\d)[lI|]/g, (_, d) => d + '1').replace(/[lI|](\d)/g, (_, d) => '1' + d);
        const out = [];
        for (const raw of cleaned.split(/[^0-9.:,;]+/)) {
            const tk = raw.replace(/^[.:,;]+|[.:,;]+$/g, '');
            let m = tk.match(/^(\d{1,2})[.:,;](\d{2})$/);
            if (!m && tk.length >= 3) m = tk.match(/^(\d{1,2})(\d{2})$/);
            if (!m) continue;
            const h = Number(m[1]), mi = Number(m[2]);
            if (h < 6 || h > 22 || mi > 59) continue;
            let v = h * 60 + mi;
            if (v % 5 === 1) v -= 1; else if (v % 5 === 4) v += 1;
            out.push(v);
        }
        return out;
    }

    // Eksik ya da hatalı okunan sütun saatlerini komşu sütunlardan tamamlar
    function inferColumnTimes(cols) {
        const c = cols.map(x => ({ start: x && x.start != null ? x.start : null, end: x && x.end != null ? x.end : null }));
        let prev = -1;
        c.forEach(col => {
            if (col.start != null && col.start < prev) col.start = null;
            if (col.end != null && (col.end <= prev || (col.start != null && col.end <= col.start))) col.end = null;
            if (col.end != null) prev = col.end; else if (col.start != null) prev = col.start;
        });
        const known = c.map(x => x.start != null && x.end != null);
        const dur = Math.round(median(c.filter(x => x.start != null && x.end != null).map(x => x.end - x.start))) || 40;
        // Teneffüs süresi: öğle arası gibi uzun boşluklar ortalamayı bozmasın
        const gaps = [];
        for (let i = 1; i < c.length; i++) if (c[i - 1].end != null && c[i].start != null) gaps.push(c[i].start - c[i - 1].end);
        const shortGaps = gaps.filter(g => g >= 0 && g <= 30);
        const gap = shortGaps.length ? Math.round(median(shortGaps)) : 10;
        c.forEach(x => {
            if (x.start != null && x.end == null) x.end = x.start + dur;
            if (x.end != null && x.start == null) x.start = x.end - dur;
        });
        // İki bilinen sütun arasındaki eksikleri aradaki boşluğa eşit yay
        for (let i = 0; i < c.length; i++) {
            if (c[i].start != null) continue;
            let j = i;
            while (j < c.length && c[j].start == null) j++;
            if (i > 0 && j < c.length) {
                const k = j - i, slot = (c[j].start - c[i - 1].end) / k;
                for (let n = 0; n < k; n++) {
                    const s = c[i - 1].end + n * slot + Math.max(0, (slot - dur) / 2);
                    c[i + n].start = Math.round(s / 5) * 5;
                    c[i + n].end = c[i + n].start + dur;
                }
            }
            i = j;
        }
        for (let i = 1; i < c.length; i++) {
            if (c[i].start == null && c[i - 1].end != null) { c[i].start = c[i - 1].end + gap; c[i].end = c[i].start + dur; }
        }
        for (let i = c.length - 2; i >= 0; i--) {
            if (c[i].start == null && c[i + 1].start != null) { c[i].end = c[i + 1].start - gap; c[i].start = c[i].end - dur; }
        }
        if (c.every(x => x.start == null)) {
            let t = 9 * 60;
            c.forEach(x => { x.start = t; x.end = t + 40; t += 50; });
        }
        return c.map((x, i) => ({ start: fmtTime(x.start), end: fmtTime(x.end), estimated: !known[i] }));
    }

    function cleanToken(t) {
        return String(t || '').replace(/[^0-9A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû\-*./]/g, '').replace(/^[-./]+|[-./]+$/g, '');
    }

    // Hücredeki kelimeleri ders adı (büyük yazı) ve öğretmen (küçük yazı) olarak ayırır
    function splitCellText(words) {
        const toks = (words || []).map(w => ({
            t: cleanToken(w.text),
            c: w.confidence == null ? 100 : w.confidence,
            x: (w.bbox.x0 + w.bbox.x1) / 2,
            y: (w.bbox.y0 + w.bbox.y1) / 2,
            h: w.bbox.y1 - w.bbox.y0
        })).filter(k => k.t && LETTER_RE.test(k.t) && k.c >= 30 && !(k.t.length <= 2 && k.c < 70));
        if (!toks.length) return null;
        const H = Math.max(...toks.map(k => k.h));
        const inReadingOrder = arr => {
            const lines = [];
            [...arr].sort((a, b) => a.y - b.y).forEach(k => {
                const line = lines.find(l => Math.abs(l.y - k.y) < H * 0.5);
                if (line) line.items.push(k); else lines.push({ y: k.y, items: [k] });
            });
            return lines.flatMap(l => l.items.sort((a, b) => a.x - b.x).map(k => k.t));
        };
        const dedupe = arr => arr.filter((t, i) => i === 0 || fold(t) !== fold(arr[i - 1]));
        const name = dedupe(inReadingOrder(toks.filter(k => k.h >= H * 0.62))).join(' ');
        const teacher = dedupe(inReadingOrder(toks.filter(k => k.h < H * 0.62)).filter(t => fold(t) !== 'grup')).join(' ');
        return name ? { name, teacher } : null;
    }

    // ═════════ GÖRÜNTÜ İŞLEME ═════════

    function loadImage(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Fotoğraf açılamadı. JPG veya PNG deneyin.')); };
            img.src = url;
        });
    }

    function canvasToGray(canvas) {
        const { width: w, height: h } = canvas;
        const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
        const gray = new Uint8ClampedArray(w * h);
        for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000;
        return gray;
    }

    function grayToCanvas(gray, w, h) {
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        const img = ctx.createImageData(w, h);
        for (let i = 0, j = 0; i < gray.length; i++, j += 4) { img.data[j] = img.data[j + 1] = img.data[j + 2] = gray[i]; img.data[j + 3] = 255; }
        ctx.putImageData(img, 0, 0);
        return canvas;
    }

    // Tabloyu okunabilir boyuta getirir (dar fotoğrafı büyütür, dev fotoğrafı küçültür)
    function workingCanvas(img) {
        const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
        let s = Math.min(2.5, Math.max(0.4, 1800 / w0));
        if (w0 * h0 * s * s > 6e6) s = Math.sqrt(6e6 / (w0 * h0));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w0 * s); canvas.height = Math.round(h0 * s);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    // Gölgeye ve eşit olmayan ışığa dayanıklı yerel eşikleme (Bradley). 1 = mürekkep
    function binarize(gray, w, h, win, t) {
        const W1 = w + 1;
        const integ = new Float64Array(W1 * (h + 1));
        for (let y = 0; y < h; y++) {
            let row = 0;
            for (let x = 0; x < w; x++) {
                row += gray[y * w + x];
                integ[(y + 1) * W1 + x + 1] = integ[y * W1 + x + 1] + row;
            }
        }
        const out = new Uint8Array(w * h);
        const r = win >> 1;
        for (let y = 0; y < h; y++) {
            const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
            for (let x = 0; x < w; x++) {
                const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
                const count = (x1 - x0 + 1) * (y1 - y0 + 1);
                const sum = integ[(y1 + 1) * W1 + x1 + 1] - integ[y0 * W1 + x1 + 1] - integ[(y1 + 1) * W1 + x0] + integ[y0 * W1 + x0];
                out[y * w + x] = gray[y * w + x] * count <= sum * (1 - t) ? 1 : 0;
            }
        }
        return out;
    }

    // Eğiklik açısını (derece) bulur: satırların en keskin hizalandığı açı
    function estimateSkew(gray, w, h) {
        const f = Math.max(1, Math.floor(w / 600));
        const sw = Math.floor(w / f), sh = Math.floor(h / f);
        const small = new Uint8ClampedArray(sw * sh);
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) small[y * sw + x] = gray[(y * f) * w + x * f];
        const bin = binarize(small, sw, sh, Math.max(9, Math.round(sw / 30)), 0.18);
        const xs = [], ys = [];
        for (let i = 0; i < bin.length; i++) if (bin[i]) { xs.push(i % sw); ys.push((i / sw) | 0); }
        if (xs.length < 50) return 0;
        const off = Math.ceil(sw * Math.tan(6 * Math.PI / 180)) + 2;
        const score = (deg) => {
            const t = Math.tan(deg * Math.PI / 180);
            const hist = new Float64Array(sh + 2 * off + 2);
            for (let i = 0; i < xs.length; i++) hist[Math.round(ys[i] - xs[i] * t) + off]++;
            let s = 0;
            for (let i = 0; i < hist.length; i++) s += hist[i] * hist[i];
            return s;
        };
        let best = 0, bestScore = -1;
        for (let a = -5; a <= 5.001; a += 0.25) { const s = score(a); if (s > bestScore) { bestScore = s; best = a; } }
        const coarse = best;
        for (let a = coarse - 0.25; a <= coarse + 0.251; a += 0.05) { const s = score(a); if (s > bestScore) { bestScore = s; best = a; } }
        return Math.round(best * 100) / 100;
    }

    function rotateCanvas(canvas, deg) {
        const out = document.createElement('canvas');
        out.width = canvas.width; out.height = canvas.height;
        const ctx = out.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.translate(out.width / 2, out.height / 2);
        ctx.rotate(-deg * Math.PI / 180);
        ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        return out;
    }

    // Uzun yatay mürekkep koşuları = tablo çizgileri (küçük boşluklara toleranslı)
    function horizontalRuns(bin, w, h, minLen, gap = 2) {
        const mask = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) {
            const o = y * w;
            let start = -1, last = -1;
            for (let x = 0; x <= w; x++) {
                if (x < w && bin[o + x]) { if (start < 0) start = x; last = x; }
                else if (start >= 0 && (x - last > gap || x === w)) {
                    if (last - start + 1 >= minLen) mask.fill(1, o + start, o + last + 1);
                    start = -1;
                }
            }
        }
        return mask;
    }

    function verticalRuns(bin, w, h, minLen, gap = 2) {
        const mask = new Uint8Array(w * h);
        for (let x = 0; x < w; x++) {
            let start = -1, last = -1;
            for (let y = 0; y <= h; y++) {
                if (y < h && bin[y * w + x]) { if (start < 0) start = y; last = y; }
                else if (start >= 0 && (y - last > gap || y === h)) {
                    if (last - start + 1 >= minLen) for (let k = start; k <= last; k++) mask[k * w + x] = 1;
                    start = -1;
                }
            }
        }
        return mask;
    }

    // Profildeki eşik üstü bölgelerin ağırlıklı merkezleri; birbirine çok yakın tepeler birleştirilir
    function findPeaks(profile, thr, minDist) {
        const peaks = [];
        let i = 0;
        while (i < profile.length) {
            if (profile[i] >= thr && profile[i] > 0) {
                let j = i, ws = 0, ps = 0;
                while (j < profile.length && profile[j] >= thr) { ws += profile[j]; ps += profile[j] * j; j++; }
                peaks.push(ps / ws);
                i = j;
            } else i++;
        }
        const merged = [];
        peaks.forEach(p => {
            if (merged.length && p - merged[merged.length - 1] < minDist) merged[merged.length - 1] = (merged[merged.length - 1] + p) / 2;
            else merged.push(p);
        });
        return merged.map(Math.round);
    }

    // Gerçek tablo çizgisi: iki yanı açık, kendisi koyu. Kâğıt kenarı / gölge sınırı: bir yanı koyu.
    // samples: [{ c: çizgi üzerindeki en koyu değer, a: bir yan, b: öbür yan }]
    function looksLikeRule(samples) {
        if (samples.length < 3) return false;
        const depth = median(samples.map(s => Math.min(s.a, s.b) - s.c));
        const sideDiff = median(samples.map(s => Math.abs(s.a - s.b)));
        return depth >= 25 && sideDiff <= Math.max(45, depth * 0.6);
    }

    function hLineSamples(gray, w, h, ys, xa, xb) {
        const out = [];
        const step = Math.max(8, Math.round((xb - xa) / 60));
        for (let x = Math.max(0, xa); x <= Math.min(w - 1, xb); x += step) {
            const y = Math.round(ys[x]);
            if (y - 12 < 0 || y + 12 >= h) continue;
            let c = 255;
            for (let k = -3; k <= 3; k++) c = Math.min(c, gray[(y + k) * w + x]);
            out.push({ c, a: Math.max(gray[(y - 10) * w + x], gray[(y - 12) * w + x]), b: Math.max(gray[(y + 10) * w + x], gray[(y + 12) * w + x]) });
        }
        return out;
    }

    function vLineSamples(gray, w, h, x, band) {
        const out = [];
        if (x - 12 < 0 || x + 12 >= w) return out;
        const t = band.top[x], b = band.bot[x];
        const step = Math.max(4, Math.round((b - t) / 20));
        for (let y = Math.round(t + (b - t) * 0.15); y < b - (b - t) * 0.15; y += step) {
            const o = y * w;
            let c = 255;
            for (let k = -3; k <= 3; k++) c = Math.min(c, gray[o + x + k]);
            out.push({ c, a: Math.max(gray[o + x - 10], gray[o + x - 12]), b: Math.max(gray[o + x + 10], gray[o + x + 12]) });
        }
        return out;
    }

    // Doğrusal ara/dış değerleme: bilinen (x, y) noktalarından her x için y
    function fillLine(xs, ys, w) {
        const pts = xs.map((x, i) => [x, ys[i]]).filter(p => p[1] != null);
        const out = new Float64Array(w);
        if (!pts.length) return null;
        if (pts.length === 1) { out.fill(pts[0][1]); return out; }
        let k = 0;
        for (let x = 0; x < w; x++) {
            while (k < pts.length - 2 && x > pts[k + 1][0]) k++;
            const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
            out[x] = y0 + (y1 - y0) * (x - x0) / (x1 - x0);
        }
        return out;
    }

    // Tablonun yatay çizgilerini bulur. Perspektif yüzünden çizgiler farklı eğimde olabileceği için
    // görüntü dikey şeritlere bölünür, her şeritte çizgi tepeleri bulunur ve şeritler arasında takip edilir.
    function detectRows(hm, gray, w, h) {
        const colCount = new Float64Array(w);
        let total = 0;
        for (let y = 0; y < h; y++) { const o = y * w; for (let x = 0; x < w; x++) if (hm[o + x]) { colCount[x]++; total++; } }
        if (!total) return null;
        let acc = 0, xmin = 0, xmax = w - 1;
        for (let x = 0; x < w; x++) { acc += colCount[x]; if (acc >= total * 0.005) { xmin = x; break; } }
        acc = 0;
        for (let x = w - 1; x >= 0; x--) { acc += colCount[x]; if (acc >= total * 0.005) { xmax = x; break; } }
        const tableW = xmax - xmin;
        if (tableW < w * 0.2) return null;

        const S = Math.max(4, Math.min(12, Math.round(tableW / 150)));
        const sw = tableW / S;
        const strips = [];
        for (let s = 0; s < S; s++) {
            const xa = Math.round(xmin + s * sw), xb = Math.round(xmin + (s + 1) * sw);
            const prof = new Float64Array(h);
            for (let y = 0; y < h; y++) {
                let c = 0;
                const o = y * w;
                for (let x = xa; x < xb; x++) c += hm[o + x];
                prof[y] = c;
            }
            const sm = new Float64Array(h);
            for (let y = 0; y < h; y++) { let v = 0; for (let k = -2; k <= 2; k++) if (y + k >= 0 && y + k < h) v += prof[y + k]; sm[y] = v; }
            strips.push({ cx: (xa + xb) / 2, peaks: findPeaks(sm, (xb - xa) * 0.6, 10) });
        }

        // En çok çizgi bulunan şeritten başlayarak sağa ve sola takip et
        let ref = 0;
        strips.forEach((st, i) => { if (st.peaks.length > strips[ref].peaks.length) ref = i; });
        const refPeaks = strips[ref].peaks;
        if (refPeaks.length < 3) return null;
        const refGaps = refPeaks.slice(1).map((y, i) => y - refPeaks[i]);
        const tol = Math.max(8, median(refGaps) * 0.3);
        const lines = refPeaks.map(y => { const arr = new Array(S).fill(null); arr[ref] = y; return arr; });
        const walk = (step) => {
            const cur = lines.map(L => L[ref]);
            for (let s = ref + step; s >= 0 && s < S; s += step) {
                const used = new Set();
                lines.forEach((L, li) => {
                    let best = -1, bd = tol;
                    strips[s].peaks.forEach((p, i) => { const d = Math.abs(p - cur[li]); if (!used.has(i) && d < bd) { bd = d; best = i; } });
                    if (best >= 0) { used.add(best); L[s] = strips[s].peaks[best]; cur[li] = L[s]; }
                });
            }
        };
        walk(1); walk(-1);

        const xs = strips.map(st => st.cx);
        const polys = lines
            .filter(L => L.filter(v => v != null).length >= Math.ceil(S * 0.5))
            .map(L => fillLine(xs, L, w))
            .filter(Boolean)
            .filter(ys => looksLikeRule(hLineSamples(gray, w, h, ys, xmin, xmax)))
            .map(ys => ({ ys, mean: ys[Math.round((xmin + xmax) / 2)] }))
            .sort((a, b) => a.mean - b.mean);
        const merged = [];
        polys.forEach(p => { if (!merged.length || p.mean - merged[merged.length - 1].mean >= 10) merged.push(p); });
        if (merged.length < 3) return null;

        const gaps = merged.slice(1).map((p, i) => p.mean - merged[i].mean);
        const medGap = median(gaps);
        const bands = [];
        for (let i = 1; i < merged.length; i++) {
            if (merged[i].mean - merged[i - 1].mean >= medGap * 0.4) {
                bands.push({ top: merged[i - 1].ys, bot: merged[i].ys, y0: merged[i - 1].mean, y1: merged[i].mean });
            }
        }
        if (bands.length < 2) return null;
        // Tablonun gerçek yatay kapsamı: doğrulanmış çizgilerin maskede sürdüğü aralık
        const mins = [], maxs = [];
        merged.forEach(p => {
            let lo = -1, hi = -1;
            for (let x = 0; x < w; x++) {
                const y = Math.round(p.ys[x]);
                let on = false;
                for (let k = -4; k <= 4 && !on; k++) if (y + k >= 0 && y + k < h && hm[(y + k) * w + x]) on = true;
                if (on) { if (lo < 0) lo = x; hi = x; }
            }
            if (lo >= 0) { mins.push(lo); maxs.push(hi); }
        });
        return { bands, xmin: Math.round(median(mins)), xmax: Math.round(median(maxs)) };
    }

    // Bant içinde [xa, xb] aralığına sığan dikdörtgen (eğik çizgilere taşmadan)
    function bandRect(band, xa, xb, pad, w, h) {
        const a = Math.max(0, Math.floor(xa)), b = Math.min(w - 1, Math.ceil(xb));
        let top = -Infinity, bot = Infinity;
        for (let x = a; x <= b; x++) { if (band.top[x] > top) top = band.top[x]; if (band.bot[x] < bot) bot = band.bot[x]; }
        return { x0: Math.max(0, xa + pad), y0: Math.max(0, top + pad), x1: Math.min(w, xb - pad), y1: Math.min(h, bot - pad) };
    }

    // Bir satır bandında dikey ayırıcı çizgilerin x konumları (eğikliğe toleranslı)
    function bandSeparators(vm, gray, w, h, band, xmin, xmax, dil = 5) {
        const xa = Math.max(0, xmin - 20), xb = Math.min(w - 1, xmax + 20);
        const ya = new Int32Array(w), yb = new Int32Array(w);
        let yMin = h, yMax = 0;
        const hs = [];
        for (let x = xa; x <= xb; x++) {
            const m = (band.bot[x] - band.top[x]) * 0.12;
            ya[x] = Math.max(0, Math.round(band.top[x] + m));
            yb[x] = Math.min(h, Math.round(band.bot[x] - m));
            hs.push(yb[x] - ya[x]);
            if (ya[x] < yMin) yMin = ya[x];
            if (yb[x] > yMax) yMax = yb[x];
        }
        const H = median(hs);
        if (H < 5) return [];
        const cover = new Float64Array(w);
        const stamp = new Int32Array(w).fill(-1);
        for (let y = yMin; y < yMax; y++) {
            const o = y * w;
            for (let x = xa; x <= xb; x++) {
                if (!vm[o + x] || y < ya[x] || y >= yb[x]) continue;
                for (let k = Math.max(0, x - dil); k <= Math.min(w - 1, x + dil); k++) {
                    if (stamp[k] !== y) { stamp[k] = y; cover[k]++; }
                }
            }
        }
        const margin = Math.max(15, w * 0.02);
        return findPeaks(cover, H * 0.55, 12)
            .filter(x => x >= xmin - margin && x <= xmax + margin)
            .filter(x => looksLikeRule(vLineSamples(gray, w, h, x, band)));
    }

    // Başlıktaki sütun ayırıcılarını satır satır takip eder; bulunamayan ayırıcı = birleşik hücre
    function trackSeparators(headerSeps, virtual, bandsSeps, colW) {
        let est = headerSeps.slice();
        const tol = colW * 0.35;
        return bandsSeps.map(peaks => {
            const used = new Set();
            const matched = est.map(() => null);
            est.forEach((x, k) => {
                if (virtual[k]) return;
                let best = -1, bd = tol;
                peaks.forEach((p, i) => { const d = Math.abs(p - x); if (!used.has(i) && d < bd) { bd = d; best = i; } });
                if (best >= 0) { used.add(best); matched[k] = peaks[best]; }
            });
            const pos = est.map((x, k) => {
                if (matched[k] != null) return matched[k];
                let l = k - 1; while (l >= 0 && matched[l] == null) l--;
                let r = k + 1; while (r < est.length && matched[r] == null) r++;
                const dl = l >= 0 ? matched[l] - est[l] : null;
                const dr = r < est.length ? matched[r] - est[r] : null;
                const d = dl != null && dr != null ? (dl + dr) / 2 : (dl != null ? dl : (dr != null ? dr : 0));
                return virtual[k] ? x : x + d;
            });
            est = pos;
            return { pos, present: matched.map((m, k) => virtual[k] || m != null) };
        });
    }

    // ═════════ YAZI TANIMA (yerel Tesseract) ═════════

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            if (global.Tesseract) return resolve();
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('Yazı tanıma motoru yüklenemedi. Sayfayı yenileyip tekrar deneyin.'));
            document.head.appendChild(s);
        });
    }

    async function createWorker(onProgress) {
        await loadScript(VENDOR + 'tesseract.min.js');
        const abs = p => new URL(p, document.baseURI).href;
        return global.Tesseract.createWorker('tur', 1, {
            workerPath: abs(VENDOR + 'worker.min.js'),
            corePath: abs(VENDOR + 'core/'),
            langPath: abs(VENDOR + 'lang'),
            workerBlobURL: false,
            gzip: true,
            logger: m => {
                if (m && /loading|initializ/.test(m.status || '')) onProgress({ phase: 'engine', progress: m.progress || 0 });
            }
        });
    }

    function collectWords(data) {
        if (Array.isArray(data && data.words) && data.words.length) return data.words;
        const out = [];
        ((data && data.blocks) || []).forEach(b => (b.paragraphs || []).forEach(p =>
            (p.lines || []).forEach(l => (l.words || []).forEach(w => out.push(w)))));
        return out;
    }

    // Hücre içini (çizgiler hariç) büyütüp okur
    async function ocrRegion(worker, src, rect, scale = 2, sink = null) {
        const cw = Math.round(rect.x1 - rect.x0), ch = Math.round(rect.y1 - rect.y0);
        if (cw < 6 || ch < 6) return { text: '', words: [] };
        const pad = 12;
        scale = Math.max(0.75, Math.min(scale, 3, 1400 / Math.max(cw, ch)));
        const iw = Math.round(cw * scale), ih = Math.round(ch * scale);
        const c = document.createElement('canvas');
        c.width = iw + pad * 2;
        c.height = ih + pad * 2;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, Math.round(rect.x0), Math.round(rect.y0), cw, ch, pad, pad, iw, ih);
        // Kontrast germe: hücre zemini beyaz, yazı koyu olsun. Gölgeli (gri) hücrede beyaz kenar boşluğu
        // ile gri zemin yan yana gelince motorun eşiği zemini yazı sanıp hücreyi kapatmasın.
        const id = ctx.getImageData(pad, pad, iw, ih);
        const d = id.data;
        const hist = new Uint32Array(256);
        for (let j = 0; j < d.length; j += 4) { const g = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000 | 0; d[j] = g; hist[g]++; }
        const n = iw * ih;
        const pct = p => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * p) return v; } return 255; };
        const lo = pct(0.01), hi = pct(0.6);
        if (hi - lo >= 20) {
            const sc = 255 / (hi - lo);
            for (let j = 0; j < d.length; j += 4) { const v = (d[j] - lo) * sc; d[j] = d[j + 1] = d[j + 2] = v < 0 ? 0 : v > 255 ? 255 : v; }
        } else {
            for (let j = 0; j < d.length; j += 4) d[j + 1] = d[j + 2] = d[j];
        }
        ctx.putImageData(id, pad, pad);
        const { data } = await worker.recognize(c, {}, { text: true, blocks: true });
        const text = (data && data.text) || '';
        if (sink) sink.push({ url: c.toDataURL('image/png'), text });
        return { text, words: collectWords(data) };
    }

    function inkRatio(bin, w, rect) {
        let ink = 0, total = 0;
        for (let y = Math.round(rect.y0); y < Math.round(rect.y1); y++) {
            for (let x = Math.round(rect.x0); x < Math.round(rect.x1); x++) { total++; ink += bin[y * w + x]; }
        }
        return total ? ink / total : 0;
    }

    // ═════════ ANA AKIŞ ═════════

    // Başlık hücresindeki saatleri okur. Büyük ders numarası küçük saat yazısını bastırabildiği için
    // önce yalnızca saat satırı (hücrenin alt kısmı) tek satır olarak büyütülüp okunur.
    async function readHeaderTimes(worker, src, rect, zoom = 1) {
        const hh = rect.y1 - rect.y0;
        const tries = [
            { rect: { ...rect, y0: rect.y0 + hh * 0.4 }, psm: '7', scale: 3 },
            { rect, psm: '6', scale: 2 },
            { rect: { ...rect, y0: rect.y0 + hh * 0.3 }, psm: '11', scale: 3 },
            { rect: { ...rect, y1: rect.y0 + hh * 0.6 }, psm: '7', scale: 3 }
        ];
        let best = { times: [], text: '' };
        for (const t of tries) {
            await worker.setParameters({ tessedit_pageseg_mode: t.psm, tessedit_char_whitelist: '0123456789.:-' });
            const r = await ocrRegion(worker, src, t.rect, t.scale / zoom);
            const times = parseTimes(r.text);
            if (times.length > best.times.length) best = { times, text: r.text };
            if (best.times.length >= 2) break;
        }
        return best;
    }

    async function read(file, opts = {}) {
        const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
        const debug = { skew: 0, rows: 0, cols: 0, text: [], crops: opts.collectCrops ? [] : null };
        read.lastDebug = debug;

        onProgress({ phase: 'prepare' });
        const img = await loadImage(file);
        let canvas = workingCanvas(img);
        const w = canvas.width, h = canvas.height;
        let gray = canvasToGray(canvas);

        // 1) Eğiklik düzeltme
        const skew = estimateSkew(gray, w, h);
        debug.skew = skew;
        if (Math.abs(skew) >= 0.2) {
            canvas = rotateCanvas(canvas, skew);
            gray = canvasToGray(canvas);
        }

        // 2) Eşikleme ve tablo çizgileri
        onProgress({ phase: 'grid' });
        const bin = binarize(gray, w, h, Math.max(15, Math.round(w / 40)), 0.15);
        const hm = horizontalRuns(bin, w, h, Math.max(40, Math.round(w * 0.04)));
        const rows = detectRows(hm, gray, w, h);
        if (!rows) throw new Error('Fotoğrafta ders programı tablosu bulunamadı. Tablonun tamamı kadrajda, düz ve net olacak şekilde tekrar çekin.');
        const bandH = median(rows.bands.map(b => b.y1 - b.y0));
        const vm = verticalRuns(bin, w, h, Math.max(30, Math.round(bandH * 0.5)));

        // Çizgi maskesi (biraz genişletilmiş): okumadan önce çizgiler beyaza boyanır
        const lm = new Uint8Array(w * h);
        for (let i = 0; i < lm.length; i++) {
            if (!hm[i] && !vm[i]) continue;
            const x = i % w, y = (i / w) | 0;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                const xx = x + dx, yy = y + dy;
                if (xx >= 0 && xx < w && yy >= 0 && yy < h) lm[yy * w + xx] = 1;
            }
        }
        const clean = new Uint8ClampedArray(gray);
        for (let i = 0; i < clean.length; i++) if (lm[i]) clean[i] = 255;
        const inkBin = binarize(clean, w, h, Math.max(15, Math.round(w / 40)), 0.2);

        // Okuma kaynağı: fotoğraf çalışma boyutundan büyükse hücreler orijinal çözünürlükten kesilir
        // (küçük saat ve öğretmen yazıları küçültmede kaybolmasın)
        const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
        const k = w0 / w;
        let ocrSrc;
        if (k > 1.15) {
            let full = document.createElement('canvas');
            full.width = w0; full.height = h0;
            const fctx = full.getContext('2d');
            fctx.fillStyle = '#ffffff';
            fctx.fillRect(0, 0, w0, h0);
            fctx.drawImage(img, 0, 0);
            if (Math.abs(skew) >= 0.2) full = rotateCanvas(full, skew);
            const fc = full.getContext('2d');
            const id = fc.getImageData(0, 0, w0, h0);
            const d = id.data;
            for (let y = 0; y < h0; y++) {
                const my = Math.min(h - 1, Math.floor(y / k)) * w;
                for (let x = 0; x < w0; x++) {
                    const j = (y * w0 + x) * 4;
                    if (lm[my + Math.min(w - 1, Math.floor(x / k))]) { d[j] = d[j + 1] = d[j + 2] = 255; }
                    else { const g = (d[j] * 299 + d[j + 1] * 587 + d[j + 2] * 114) / 1000; d[j] = d[j + 1] = d[j + 2] = g; }
                }
            }
            fc.putImageData(id, 0, 0);
            ocrSrc = full;
        } else {
            ocrSrc = grayToCanvas(clean, w, h);
        }
        const kk = k > 1.15 ? k : 1;
        const toSrc = r => ({ x0: r.x0 * kk, y0: r.y0 * kk, x1: r.x1 * kk, y1: r.y1 * kk });

        const bandsSeps = rows.bands.map(b => bandSeparators(vm, gray, w, h, b, rows.xmin, rows.xmax));
        // Bandın ayırıcıları + kadraj dışında kalan tablo kenarları için sanal kenarlar
        const sepsOf = (bi) => {
            const seps = bandsSeps[bi].slice();
            if (seps.length < 2) return null;
            const colW = median(seps.slice(1).map((x, i) => x - seps[i]));
            const virtual = seps.map(() => false);
            if (seps[0] - rows.xmin > colW * 0.3) { seps.unshift(rows.xmin); virtual.unshift(true); }
            if (rows.xmax - seps[seps.length - 1] > colW * 0.3) { seps.push(rows.xmax); virtual.push(true); }
            return { seps, virtual, colW };
        };

        const worker = await createWorker(onProgress);
        try {
            const setMode = (psm, whitelist = '') => worker.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: whitelist });
            const dayCache = new Map();
            const readDayCell = async (bi, x0, x1) => {
                if (!dayCache.has(bi)) {
                    const r = await ocrRegion(worker, ocrSrc, toSrc(bandRect(rows.bands[bi], x0, x1, 4, w, h)), 2 / kk);
                    dayCache.set(bi, r.text.replace(/\s+/g, ' ').trim());
                }
                return dayCache.get(bi);
            };

            // 3) Düzen: ilk gün etiketli satırı bul; başlık onun hemen üstündeki satırdır
            onProgress({ phase: 'layout' });
            await setMode('11');
            let firstDay = -1;
            for (let bi = 0; bi < Math.min(5, rows.bands.length) && firstDay < 0; bi++) {
                const s = sepsOf(bi);
                if (!s) continue;
                const d = dayFromCellText(await readDayCell(bi, s.seps[0], s.seps[1]));
                if (d && d !== 'skip') firstDay = bi;
            }
            const hasHeader = firstDay !== 0;
            const headerIndex = firstDay > 0 ? firstDay - 1 : 0;
            const bodyStart = hasHeader ? headerIndex + 1 : 0;

            // Sütun şablonu: başlık (yoksa ilk satırlar) içinde en çok ayırıcısı olan bant
            let tpl = null;
            for (let bi = headerIndex; bi < Math.min(rows.bands.length, headerIndex + 3); bi++) {
                const s = sepsOf(bi);
                if (s && s.seps.length >= 3 && (!tpl || s.seps.length > tpl.seps.length)) tpl = s;
            }
            if (!tpl) throw new Error('Tablonun sütunları bulunamadı. Fotoğrafı daha düz ve yakından çekin.');
            const nCols = tpl.seps.length - 2;

            // 4) Ders saatleri (başlık satırından)
            const cols = [];
            if (hasHeader) {
                const hb = rows.bands[headerIndex];
                for (let c = 1; c <= nCols; c++) {
                    onProgress({ phase: 'header', done: c, total: nCols });
                    const r = await readHeaderTimes(worker, ocrSrc, toSrc(bandRect(hb, tpl.seps[c], tpl.seps[c + 1], 6, w, h)), kk);
                    debug.text.push(`[başlık ${c}] ${r.text.replace(/\s+/g, ' ').trim()}`);
                    // Tek başına okunan saat başlangıç mı bitiş mi belli değil; yalnızca makul çiftler kullanılır
                    const dur = r.times.length >= 2 ? r.times[1] - r.times[0] : 0;
                    cols.push(dur >= 20 && dur <= 120 ? { start: r.times[0], end: r.times[1] } : {});
                }
            } else {
                for (let c = 1; c <= nCols; c++) cols.push({});
            }
            const times = inferColumnTimes(cols);
            debug.cols = nCols;

            // 5) Ders satırları
            await setMode('11');
            const bodyBands = rows.bands.slice(bodyStart);
            const tracks = trackSeparators(tpl.seps, tpl.virtual, bandsSeps.slice(bodyStart), tpl.colW);
            const jobs = bodyBands.map((band, r) => {
                const { pos, present } = tracks[r];
                const cells = [];
                let i = 1;
                while (i < pos.length - 1) {
                    let j = i + 1;
                    while (j < pos.length - 1 && !present[j]) j++;
                    const rect = bandRect(band, pos[i], pos[j], 5, w, h);
                    if (rect.x1 > rect.x0 && rect.y1 > rect.y0 && inkRatio(inkBin, w, rect) >= 0.004) cells.push({ c0: i, c1: j - 1, rect });
                    i = j;
                }
                return { bi: bodyStart + r, pos, cells };
            });
            const total = jobs.reduce((s, j) => s + j.cells.length + 1, 0);
            let done = 0;

            const rowsOut = [];
            for (const job of jobs) {
                onProgress({ phase: 'cells', done: ++done, total });
                const dayText = await readDayCell(job.bi, job.pos[0], job.pos[1]);
                const day = dayFromCellText(dayText);
                // İmza / Sınıf öğretmeni satırlarından sonrası ders programı değildir
                if (day === 'skip') break;
                const courses = [];
                for (const cell of job.cells) {
                    onProgress({ phase: 'cells', done: ++done, total });
                    const r = await ocrRegion(worker, ocrSrc, toSrc(cell.rect), 2 / kk, debug.crops);
                    debug.text.push(`[${dayText || '?'} ${cell.c0}${cell.c1 > cell.c0 ? '-' + cell.c1 : ''}] ${r.text.replace(/\s+/g, ' ').trim()}`);
                    const parsed = splitCellText(r.words);
                    if (parsed) courses.push({ ...parsed, c0: cell.c0, c1: cell.c1 });
                }
                rowsOut.push({ dayText, day, courses });
            }

            // 6) Günleri eşle: okunamayan gün etiketleri sıradan çıkarılır
            const firstKnown = rowsOut.findIndex(r => r.day);
            rowsOut.forEach((r, i) => {
                if (r.day) return;
                let kk2 = i - 1;
                while (kk2 >= 0 && !rowsOut[kk2].day) kk2--;
                if (kk2 >= 0) {
                    const idx = DAY_NAMES.indexOf(rowsOut[kk2].day) + (i - kk2);
                    r.day = idx < DAY_NAMES.length ? DAY_NAMES[idx] : '';
                } else if (firstKnown > i) {
                    const idx = DAY_NAMES.indexOf(rowsOut[firstKnown].day) - (firstKnown - i);
                    r.day = idx >= 0 ? DAY_NAMES[idx] : '';
                } else if (firstKnown < 0) {
                    r.day = DAY_NAMES[i] || '';
                }
                r.dayGuessed = !!r.day;
            });

            const items = [];
            rowsOut.forEach(r => {
                if (!r.day) return;
                r.courses.forEach(c => {
                    const t0 = times[c.c0 - 1], t1 = times[c.c1 - 1];
                    if (!t0 || !t1) return;
                    items.push({
                        day: r.day, name: c.name, teacher: c.teacher,
                        start: t0.start, end: t1.end,
                        period: c.c0, periodEnd: c.c1,
                        dayGuessed: !!r.dayGuessed,
                        uncertain: !!(r.dayGuessed || t0.estimated || t1.estimated)
                    });
                });
            });
            debug.rows = rowsOut.length;
            // periods: sütun (ders saati) başına başlangıç/bitiş; estimated = başlıktan okunamadı, tahmin edildi
            return { items, periods: times };
        } finally {
            try { await worker.terminate(); } catch (e) { /* yoksay */ }
        }
    }

    global.ScheduleReader = {
        read,
        _internals: { fold, normalizeDay, dayFromCellText, parseTimes, inferColumnTimes, splitCellText, findPeaks, fillLine, trackSeparators, binarize, estimateSkew, workingCanvas, canvasToGray, rotateCanvas, horizontalRuns, verticalRuns, detectRows, bandSeparators, loadImage, createWorker, ocrRegion, bandRect, grayToCanvas }
    };
})(typeof window !== 'undefined' ? window : globalThis);
