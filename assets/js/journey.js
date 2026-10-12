/* Fahrschule Easy Drive – "Die Fahrt": scroll-driven map journey.
   Vanilla JS, no dependencies. Structure after oso95/scroll-world's scrub-engine
   (fixed stage, segments with dwell + travel, per-stop copy, route dots, reduced-motion
   fallback), driving an inline SVG map instead of video clips. */
(function () {
  "use strict";
  var J = {};
  var clamp = function (x, a, b) { return Math.min(b, Math.max(a, x)); };
  var smooth = function (x) { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  J.clamp = clamp; J.smooth = smooth;

  // progress 0..1 over the segments. spansOrN: array of per-segment spans, or the number of stops (uniform).
  // D: dwell fraction of a segment at each of its ends - a number, or a function (segmentIndex) -> number.
  J.phaseAt = function (progress, spansOrN, D) {
    var spans = typeof spansOrN === "number" ? new Array(spansOrN - 1).fill(1) : spansOrN;
    var dwell = typeof D === "function" ? D : function () { return D; };
    var total = 0, i; for (i = 0; i < spans.length; i++) total += spans[i];
    var p = clamp(progress, 0, 1) * total, seg = 0, acc = 0;
    while (seg < spans.length - 1 && p >= acc + spans[seg]) { acc += spans[seg]; seg++; }
    var t = clamp((p - acc) / spans[seg], 0, 1);
    if (progress >= 1) { seg = spans.length - 1; t = 1; }
    var d = dwell(seg);
    if (t < d) return { seg: seg, t: t, phase: "dwell", stop: seg, u: 0 };
    if (t > 1 - d) return { seg: seg, t: t, phase: "dwell", stop: seg + 1, u: 1 };
    return { seg: seg, t: t, phase: "travel", stop: seg, u: (t - d) / (1 - 2 * d) };
  };
  J.progressOfStop = function (i, spans) {
    var total = 0, acc = 0, k; for (k = 0; k < spans.length; k++) total += spans[k];
    if (i >= spans.length) return 1;
    for (k = 0; k < i; k++) acc += spans[k];
    return acc / total;
  };
  J.dwellOf = function (segment) { return segment && segment.stay ? 0.3 : 0.16; };
  J.stopPhase = function (ph, D) {
    if (ph.phase !== "dwell") return null;
    var d = (typeof D === "function" ? D : function () { return D; })(ph.seg);
    if (ph.stop === ph.seg + 1) return 0.5 * clamp((ph.t - (1 - d)) / d, 0, 1);
    return 0.5 + 0.5 * clamp(ph.t / d, 0, 1);
  };
  J.breathe = function (w, s, overview) { return (s == null || overview) ? w : w * (1.04 - 0.07 * s); };

  // Camera (centre + visible width in map units). car(u) returns [x, y] on the route.
  J.cameraAt = function (stops, segment, ph, car, travelW, liveDwells) {
    var a = stops[ph.seg], b = stops[ph.seg + 1] || a;
    if (ph.phase === "dwell") { var s = stops[ph.stop]; return { cx: s.x, cy: s.y, w: s.w }; }
    var u = ph.u, e = smooth(u);
    // Join the end of the departure push-in to the start of the arrival push-in.
    var aw = liveDwells ? J.breathe(a.w, 1, a.overview) : a.w, bw = liveDwells ? J.breathe(b.w, 0, b.overview) : b.w;
    if (segment.stay) return { cx: a.x + (b.x - a.x) * e, cy: a.y + (b.y - a.y) * e, w: aw + (bw - aw) * e };
    var p = car(u);
    var lift = Math.sin(Math.PI * u);
    var base = aw + (bw - aw) * e;
    return { cx: p[0], cy: p[1], w: base + (travelW - base) * lift };
  };

  J.viewBoxFor = function (cam, aspect) { var h = cam.w / aspect; return [cam.cx - cam.w / 2, cam.cy - h / 2, cam.w, h]; };

  // The generator uses M/L for roads and M/l/Z for polygons. Cache each contour's
  // bounds once; keep any other SVG syntax intact rather than guessing its bounds.
  J.pathChunks = function (d) {
    if (!d) return [];
    if (d[0] !== "M" || /[^MLlZ0-9.,\s+-]/.test(d)) return [{ d: d }];
    return d.match(/M[^M]*/g).map(function (part) {
      var commands = part.match(/[MLl][^MLlZ]*/g) || [], x = 0, y = 0;
      var box = { d: part, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      for (var k = 0; k < commands.length; k++) {
        var command = commands[k], values = command.slice(1).trim().split(/[,\s]+/).map(Number);
        if (values.length % 2 || values.some(function (v) { return !isFinite(v); })) return { d: part };
        for (var i = 0; i < values.length; i += 2) {
          x = (command[0] === "l" ? x : 0) + values[i]; y = (command[0] === "l" ? y : 0) + values[i + 1];
          box.minX = Math.min(box.minX, x); box.minY = Math.min(box.minY, y);
          box.maxX = Math.max(box.maxX, x); box.maxY = Math.max(box.maxY, y);
        }
      }
      return box;
    });
  };
  J.visiblePath = function (chunks, vb, margin) {
    return chunks.filter(function (b) {
      return b.minX == null || (b.maxX >= vb[0] - margin && b.minX <= vb[0] + vb[2] + margin && b.maxY >= vb[1] - margin && b.minY <= vb[1] + vb[3] + margin);
    }).map(function (b) { return b.d; }).join("");
  };

  // Framing on top of the raw camera: keep the stop clear of the copy (desktop: centre shifted
  // left, phone: centre shifted down). The shift fades out in flight and is zero at the overview.
  J.frameCamera = function (cam, W, H, ph, stops, segment, reduce) {
    var w = cam.w, cx = cam.cx, cy = cam.cy;
    if (W <= 860) w = w * 0.75;
    var a = stops[ph.seg] || {}, b = stops[ph.seg + 1] || a;
    var sA = a.overview ? 0 : 1, sB = b.overview ? 0 : 1, s;
    if (ph.phase === "dwell") s = (stops[ph.stop] || {}).overview ? 0 : 1;
    else if (segment && segment.stay) s = sA + (sB - sA) * smooth(ph.u);
    else if (reduce) s = ph.u < 0.5 ? sA : sB;
    else s = (1 - Math.sin(Math.PI * ph.u)) * (ph.u < 0.5 ? sA : sB);
    if (W > 860) cx = cx - w * 0.24 * s;
    if (W <= 860) cy = cy + (w / (W / H)) * 0.23 * s;
    return { cx: cx, cy: cy, w: w };
  };
  J.approach = function (cur, target, dtMs, tauMs) {
    if (Math.abs(target - cur) < 0.00005) return target;
    var k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
    return cur + (target - cur) * k;
  };
  J.swipeDir = function (dx, dy) { if (Math.abs(dx) < 48 || Math.abs(dx) <= 1.5 * Math.abs(dy)) return 0; return dx < 0 ? 1 : -1; };
  // Fit the route into the part of the viewport left clear by the copy and navigation.
  J.fitOverview = function (cam, W, H, rect, bounds) {
    var w = Math.max(cam.w * W / Math.max(1, rect.width), bounds.height * 1.25 * W / Math.max(1, rect.height));
    return { cx: cam.cx + (W / 2 - rect.left - rect.width / 2) * w / W, cy: cam.cy + (H / 2 - rect.top - rect.height / 2) * w / W, w: w };
  };
  J.angleLerp = function (a, b, t) { var d = ((b - a + 540) % 360) - 180; return a + d * t; };
  J.introCamera = function (cam, t) { return { cx: cam.cx, cy: cam.cy, w: cam.w * (1.5 - 0.5 * smooth(t)) }; };
  // 0..1 darkness for the night stop k: fades in over the last 40 % of the approach, out over the first 40 % of the departure.
  J.nightAt = function (ph, k) {
    if (ph.phase === "dwell") return ph.stop === k ? 1 : 0;
    if (ph.seg === k - 1) return smooth((ph.u - 0.6) / 0.4);
    if (ph.seg === k) return 1 - smooth(ph.u / 0.4);
    return 0;
  };
  J.progressFromSearch = function (s) { var m = /[?&]jy=([0-9.]+)/.exec(s || ""); return m ? clamp(parseFloat(m[1]), 0, 1) : null; };

  // Which copy is on screen: the dwell stop, or (on a stay segment) the nearer of its two stops.
  J.activeStop = function (ph, segment) {
    if (ph.phase === "dwell") return ph.stop;
    if (segment && segment.stay) return ph.u < 0.5 ? ph.seg : ph.seg + 1;
    return -1;
  };

  J.init = function (doc, win) {
    var root = doc.getElementById("journey"); if (!root) return;
    var data = win.EASYDRIVE_JOURNEY; if (!data || !data.stops || !data.stops.length) return;
    var reduce = !!(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    var stage = root.querySelector(".jy-stage");
    var sheet = root.querySelector(".jy-copylayer"), footer = doc.querySelector ? doc.querySelector(".sticky") : null;
    var copies = Array.prototype.slice.call(root.querySelectorAll(".jy-copy"));
    var dotsHost = root.querySelector(".jy-route");
    var hint = root.querySelector(".jy-hint");
    if (!stage) return;
    root.classList.remove("jy--static");
    var n = data.stops.length;
    var spans = data.segments.map(function (s) { return s.span || 1; });
    var D = function (i) { return J.dwellOf(data.segments[i]); };
    var svg = null, segPaths = [], segLen = [], car = null, stopEls = [], lastAng = 0, dots = [];

    var pulses = [], night = null, stopsG = null, introStart = 0, nightIndex = -1;
    var routeG = null, routeBounds = null, backgrounds = [];

    if (dotsHost) data.stops.forEach(function (s, i) {
      var b = doc.createElement("button"); b.type = "button"; b.className = "jy-route__dot";
      var label = copies[i] && copies[i].getAttribute("data-label") ? copies[i].getAttribute("data-label") : s.label;
      b.setAttribute("aria-label", label);
      b.innerHTML = '<span class="jy-route__label"></span><i></i>';
      b.querySelector(".jy-route__label").textContent = label;
      b.addEventListener("click", function () { jumpTo(i); });
      dotsHost.appendChild(b); dots.push(b);
    });

    var url = stage.getAttribute("data-map");
    if (url && typeof win.fetch === "function") {
      win.fetch(url).then(function (r) { return r.ok ? r.text() : Promise.reject(new Error("map " + r.status)); }).then(function (txt) {
        stage.innerHTML = txt;
        svg = stage.querySelector("svg");
        if (!svg) return;
        svg.removeAttribute("width"); svg.removeAttribute("height");
        svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
        backgrounds = Array.prototype.map.call(svg.querySelectorAll("#map path, #areas path, defs path[id^='bld-']"), function (el) {
          var d = el.getAttribute("d") || ""; return { el: el, d: d, chunks: J.pathChunks(d) };
        });
        segPaths = data.segments.map(function (_, i) { return svg.querySelector("#seg-" + i); }); segLen = [];
        pulses = data.segments.map(function (_, i) { return svg.querySelector("#pulse-" + i); }); night = svg.querySelector("#night"); stopsG = svg.querySelector("#stops"); nightIndex = data.stops.findIndex(function (s) { return s.id === "praxis"; });
        routeG = svg.querySelector("#route"); routeBounds = routeG ? routeG.getBBox() : null;
        car = svg.querySelector("#car");
        stopEls = data.stops.map(function (s) { return svg.querySelector("#stop-" + s.id); });
        stopEls.forEach(function (el, i) { if (!el) return; el.addEventListener("click", activate(i)); el.addEventListener("keydown", activate(i)); });
        Array.prototype.forEach.call(svg.querySelectorAll("#landmarks [data-stop]"), function (el) {
          var i = -1; data.stops.forEach(function (s, k) { if (s.id === el.getAttribute("data-stop")) i = k; });
          if (i >= 0) el.addEventListener("click", activate(i));
        });
        if (reduce && car) car.style.display = "none";
        stage.classList.add("is-ready");
        var p0 = J.progressFromSearch(win.location ? win.location.search : ""); if (p0 != null) { var m0 = metrics(); win.scrollTo({ top: (win.scrollY || 0) + m0.top + p0 * m0.total, behavior: "instant" }); } else if (!reduce && metrics().progress < 0.02) { introStart = Date.now(); }
        targetP = metrics().progress; curP = targetP;
        onScroll();
      }).catch(function () { stage.classList.add("is-fallback"); root.classList.add("jy--static"); });
    } else { root.classList.add("jy--static"); }

    function metrics() {
      var r = root.getBoundingClientRect();
      var vh = win.innerHeight || 1;
      var total = Math.max(1, r.height - vh);
      return { top: r.top, total: total, progress: clamp(-r.top / total, 0, 1) };
    }
    function jumpTo(i) {
      var m = metrics();
      var p = J.progressOfStop(i, spans);
      var y = (win.scrollY || win.pageYOffset || 0) + m.top + p * m.total;
      win.scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });
    }
    function nearestStop() { var ph = J.phaseAt(metrics().progress, spans, D); return ph.phase === "dwell" ? ph.stop : (ph.u < 0.5 ? ph.seg : ph.seg + 1); }
    var tx = null, ty = null;
    stage.addEventListener("touchstart", function (e) { var t = e.changedTouches[0]; tx = t.clientX; ty = t.clientY; }, { passive: true });
    stage.addEventListener("touchend", function (e) {
      if (tx == null) return; var t = e.changedTouches[0]; var dir = J.swipeDir(t.clientX - tx, t.clientY - ty); tx = ty = null;
      if (dir) jumpTo(clamp(nearestStop() + dir, 0, n - 1));
    }, { passive: true });
    function activate(i) { return function (e) { if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return; e.preventDefault(); jumpTo(i); }; }
    function pointOn(i, u) { var path = segPaths[i]; if (!path) return [data.stops[i].x, data.stops[i].y]; if (segLen[i] == null) segLen[i] = path.getTotalLength(); var pt = path.getPointAtLength(segLen[i] * clamp(u, 0, 1)); return [pt.x, pt.y]; }
    function parkedAt(k) {
      for (var i = k - 1; i >= 0; i--) if (segPaths[i] && !data.segments[i].stay) return pointOn(i, 1);
      for (var j = k; j < segPaths.length; j++) if (segPaths[j] && !data.segments[j].stay) return pointOn(j, 0);
      return [data.stops[k].x, data.stops[k].y];
    }
    // Camera centre of a stop = where the car parks (a road node), so dwell and departure share one frame.
    function centreOf(k) { var st = data.stops[k]; if (st.overview) return { cx: st.x, cy: st.y, w: st.w }; var pp = parkedAt(k); return { cx: pp[0], cy: pp[1], w: st.w }; }

    function render(p) {
      if (!svg) return;
      var ph = J.phaseAt(p, spans, D);
      var seg = data.segments[ph.seg] || { stay: true };
      if (!reduce && ph.phase === "travel" && !seg.stay) ph = { seg: ph.seg, t: ph.t, phase: ph.phase, stop: ph.stop, u: smooth(ph.u) };
      var active = J.activeStop(ph, seg), overviewOn = active >= 0 && !!data.stops[active].overview;
      copies.forEach(function (c, i) { c.classList.toggle("is-on", i === active); });
      var footerH = footer ? footer.offsetHeight : 0;
      root.style.setProperty("--jy-footer", footerH + "px");
      var path = segPaths[ph.seg];
      var carAt = function (u) { return (path && !seg.stay) ? pointOn(ph.seg, u) : [data.stops[ph.seg].x, data.stops[ph.seg].y]; };
      var cam;
      if (reduce) cam = centreOf(ph.phase === "dwell" ? ph.stop : (ph.u < 0.5 ? ph.seg : ph.seg + 1));
      else if (ph.phase === "dwell") cam = centreOf(ph.stop);
      else if (seg.stay) { var A = centreOf(ph.seg), B = centreOf(ph.seg + 1), e = smooth(ph.u); A.w = J.breathe(A.w, 1, data.stops[ph.seg].overview); B.w = J.breathe(B.w, 0, data.stops[ph.seg + 1].overview); cam = { cx: A.cx + (B.cx - A.cx) * e, cy: A.cy + (B.cy - A.cy) * e, w: A.w + (B.w - A.w) * e }; }
      else cam = J.cameraAt(data.stops, seg, ph, carAt, data.travelZoom, true);
      var sp = J.stopPhase(ph, D);
      if (!reduce) cam = { cx: cam.cx, cy: cam.cy, w: J.breathe(cam.w, sp, !!data.stops[ph.stop].overview) };
      var copyPhase = sp;
      if (copyPhase == null && seg.stay) copyPhase = active === ph.seg ? 1 : 0;
      root.style.setProperty("--jy-stop", reduce || copyPhase == null ? "0.5" : copyPhase.toFixed(3));
      var W = stage.clientWidth || 1, H = stage.clientHeight || 1, aspect = W / H;
      cam = J.frameCamera(cam, W, H, ph, data.stops, seg, reduce);
      var overviewMix = overviewOn && ph.phase === "dwell" ? 1 : (seg.stay && data.stops[ph.seg + 1].overview ? smooth(ph.u) : 0);
      if (overviewMix && data.overview && routeBounds) {
        var ov = { cx: data.overview.x, cy: data.overview.y, w: data.overview.w };
        var rect;
        if (W > 860) {
          var left = clamp(W * 0.05, 16, 64) + (copies[n - 1] ? copies[n - 1].offsetWidth : Math.min(W * 0.44, 520)) + 32;
          rect = { left: left, top: 96, width: W - left - 70, height: H - 128 };
        } else rect = { left: 24, top: 160, width: W - 48, height: H - footerH - (sheet ? sheet.offsetHeight : H * 0.46) - 176 };
        var fitted = J.fitOverview(ov, W, H, rect, routeBounds);
        var base = J.frameCamera(ov, W, H, { seg: n - 2, phase: "dwell", stop: n - 1, u: 1 }, data.stops, seg, reduce);
        cam = { cx: cam.cx + (fitted.cx - base.cx) * overviewMix, cy: cam.cy + (fitted.cy - base.cy) * overviewMix, w: cam.w + (fitted.w - base.w) * overviewMix };
      }
      if (introStart) { var it = (Date.now() - introStart) / 1100; if (it >= 1 || p > 0.02) introStart = 0; else cam = J.introCamera(cam, it); }
      if (car && !reduce) {
        var pos, ang = lastAng;
        if (ph.phase === "travel" && !seg.stay && path) {
          var a = pointOn(ph.seg, ph.u), b = pointOn(ph.seg, Math.min(1, ph.u + 0.004));
          pos = a; if (b[0] !== a[0] || b[1] !== a[1]) { var target = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; ang = J.angleLerp(lastAng, target, 0.35); lastAng = ang; }
        } else pos = parkedAt(ph.phase === "dwell" ? ph.stop : ph.seg);
        var sc = Math.max(0.55, cam.w / 1400);
        car.setAttribute("transform", "translate(" + pos[0].toFixed(1) + " " + pos[1].toFixed(1) + ") rotate(" + ang.toFixed(1) + ") scale(" + sc.toFixed(2) + ")");
      }
      // Finish route geometry reads before the camera write invalidates SVG layout.
      var vb = J.viewBoxFor(cam, aspect);
      backgrounds.forEach(function (b) {
        // Generous halo covers the widest river stroke and the building wall offset.
        var d = J.visiblePath(b.chunks, vb, 154);
        if (d !== b.d) { b.el.setAttribute("d", d); b.d = d; }
      });
      svg.setAttribute("viewBox", vb.map(function (v) { return Math.round(v * 10) / 10; }).join(" "));

      segPaths.forEach(function (p, i) {
        if (!p) return;
        var off = i < ph.seg ? 0 : i > ph.seg ? 1000 : Math.round(1000 * (1 - (ph.phase === "travel" ? ph.u : (ph.stop === ph.seg ? 0 : 1))));
        p.style.strokeDashoffset = off;
        p.classList.toggle("route--done", i < ph.seg);
        p.style.strokeWidth = overviewOn ? 2.5 * cam.w / W : "";
        var pu = pulses[i]; if (pu) { var on = !reduce && ph.phase === "travel" && i === ph.seg && !seg.stay; pu.style.opacity = on ? 1 : 0; if (on) pu.style.strokeDashoffset = -Math.round(ph.u * 1000); }
      });
      var nv = nightIndex < 0 ? 0 : (reduce ? (J.activeStop(ph, seg) === nightIndex ? 1 : 0) : J.nightAt(ph, nightIndex)); if (night) night.setAttribute("opacity", (0.32 * nv).toFixed(3)); if (car) car.classList.toggle("is-night", nv >= 0.5);
      if (stopsG) stopsG.classList.toggle("is-overview", overviewOn);
      if (routeG) routeG.classList.toggle("is-overview", overviewOn);
      svg.classList.toggle("is-overview", overviewOn); svg.classList.toggle("is-night", nv >= 0.5);
      stopEls.forEach(function (el, i) {
        if (!el) return;
        var st = data.stops[i], visible = !st.overview && (overviewOn || i === active);
        el.classList.toggle("is-active", i === active);
        el.style.visibility = visible ? "visible" : "hidden";
        el.style.pointerEvents = visible ? "all" : "none";
        el.setAttribute("tabindex", visible ? "0" : "-1");
        el.setAttribute("transform", "translate(" + st.x + " " + st.y + ") scale(" + (overviewOn ? Math.max(1, cam.w / W * 0.65) : 1) + ")");
      });
      dots.forEach(function (d, i) { var near = ph.phase === "dwell" ? ph.stop : (ph.u < 0.5 ? ph.seg : ph.seg + 1); d.classList.toggle("is-active", i === near); if (i === near) d.setAttribute("aria-current", "step"); else d.removeAttribute("aria-current"); });
      if (hint) hint.style.opacity = clamp(1 - p * 12, 0, 1);
      root.style.setProperty("--jy-progress", p.toFixed(4));
    }

    var targetP = 0, curP = 0, running = false, lastT = 0;
    var raf = win.requestAnimationFrame || function (f) { f(Date.now()); };
    function frame(now) {
      running = false;
      var dt = lastT ? Math.min(100, now - lastT) : 16; lastT = now;
      curP = reduce ? targetP : J.approach(curP, targetP, dt, 90);
      render(curP);
      if (curP !== targetP || introStart) { running = true; raf(frame); } else lastT = 0;
    }
    function kick() { if (!running) { running = true; raf(frame); } }
    var onScroll = function () { targetP = metrics().progress; kick(); };
    win.addEventListener("scroll", function () { introStart = 0; onScroll(); }, { passive: true });
    win.addEventListener("resize", onScroll);
  };

  if (typeof window !== "undefined") {
    window.EasyJourney = J;
    if (typeof document !== "undefined" && document.readyState !== "loading" && document.getElementById) J.init(document, window);
    else if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", function () { J.init(document, window); });
  }
})();
