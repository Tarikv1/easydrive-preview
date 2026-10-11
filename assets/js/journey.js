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

  // progress 0..1 across (n-1) segments. Each segment: dwell D at its start stop,
  // travel in the middle, dwell D at its end stop.
  J.phaseAt = function (progress, n, D) {
    var segs = n - 1;
    var p = clamp(progress, 0, 1) * segs;
    var seg = Math.min(segs - 1, Math.floor(p));
    var t = p - seg;
    if (progress >= 1) { seg = segs - 1; t = 1; }
    if (t < D) return { seg: seg, t: t, phase: "dwell", stop: seg, u: 0 };
    if (t > 1 - D) return { seg: seg, t: t, phase: "dwell", stop: seg + 1, u: 1 };
    return { seg: seg, t: t, phase: "travel", stop: seg, u: (t - D) / (1 - 2 * D) };
  };

  // Camera (centre + visible width in map units). car(u) returns [x, y] on the route.
  J.cameraAt = function (stops, segment, ph, car, travelW) {
    var a = stops[ph.seg], b = stops[ph.seg + 1] || a;
    if (ph.phase === "dwell") { var s = stops[ph.stop]; return { cx: s.x, cy: s.y, w: s.w }; }
    var u = ph.u, e = smooth(u);
    if (segment.stay) return { cx: a.x + (b.x - a.x) * e, cy: a.y + (b.y - a.y) * e, w: a.w + (b.w - a.w) * e };
    var p = car(u);
    var lift = Math.sin(Math.PI * u);
    var base = a.w + (b.w - a.w) * e;
    return { cx: p[0], cy: p[1], w: base + (travelW - base) * lift };
  };

  J.viewBoxFor = function (cam, aspect) { var h = cam.w / aspect; return [cam.cx - cam.w / 2, cam.cy - h / 2, cam.w, h]; };

  // Framing on top of the raw camera: keep the stop clear of the copy (desktop: centre shifted
  // left, phone: centre shifted down). The shift fades out in flight and is zero at the overview.
  J.frameCamera = function (cam, W, H, ph, stops, segment, reduce) {
    var w = cam.w, cx = cam.cx, cy = cam.cy;
    if (W < 600) w = w * 0.75;
    var a = stops[ph.seg] || {}, b = stops[ph.seg + 1] || a;
    var sA = a.overview ? 0 : 1, sB = b.overview ? 0 : 1, s;
    if (ph.phase === "dwell") s = (stops[ph.stop] || {}).overview ? 0 : 1;
    else if (segment && segment.stay) s = sA + (sB - sA) * smooth(ph.u);
    else if (reduce) s = ph.u < 0.5 ? sA : sB;
    else s = (1 - Math.sin(Math.PI * ph.u)) * (ph.u < 0.5 ? sA : sB);
    if (W > 860) cx = cx - w * 0.24 * s;
    if (W < 600) cy = cy + (w / (W / H)) * 0.18 * s;
    return { cx: cx, cy: cy, w: w };
  };
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
    var copies = Array.prototype.slice.call(root.querySelectorAll(".jy-copy"));
    var dotsHost = root.querySelector(".jy-route");
    var hint = root.querySelector(".jy-hint");
    if (!stage) return;
    root.classList.remove("jy--static");
    var n = data.stops.length, D = 0.3;
    var svg = null, segPaths = [], segLen = [], car = null, stopEls = [], ticking = false, lastAng = 0, dots = [];

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
        segPaths = data.segments.map(function (_, i) { return svg.querySelector("#seg-" + i); }); segLen = [];
        car = svg.querySelector("#car");
        stopEls = data.stops.map(function (s) { return svg.querySelector("#stop-" + s.id); });
        if (reduce && car) car.style.display = "none";
        stage.classList.add("is-ready");
        render();
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
      var segs = n - 1;
      var p = i === 0 ? 0 : (i - D / 2) / segs;
      var y = (win.scrollY || win.pageYOffset || 0) + m.top + p * m.total;
      win.scrollTo({ top: y, behavior: reduce ? "auto" : "smooth" });
    }
    function pointOn(i, u) { var path = segPaths[i]; if (!path) return [data.stops[i].x, data.stops[i].y]; if (segLen[i] == null) segLen[i] = path.getTotalLength(); var pt = path.getPointAtLength(segLen[i] * clamp(u, 0, 1)); return [pt.x, pt.y]; }
    function parkedAt(k) {
      for (var i = k - 1; i >= 0; i--) if (segPaths[i] && !data.segments[i].stay) return pointOn(i, 1);
      for (var j = k; j < segPaths.length; j++) if (segPaths[j] && !data.segments[j].stay) return pointOn(j, 0);
      return [data.stops[k].x, data.stops[k].y];
    }
    // Camera centre of a stop = where the car parks (a road node), so dwell and departure share one frame.
    function centreOf(k) { var st = data.stops[k]; if (st.overview) return { cx: st.x, cy: st.y, w: st.w }; var pp = parkedAt(k); return { cx: pp[0], cy: pp[1], w: st.w }; }

    function render() {
      ticking = false;
      if (!svg) return;
      var m = metrics();
      var ph = J.phaseAt(m.progress, n, D);
      var seg = data.segments[ph.seg] || { stay: true };
      var path = segPaths[ph.seg];
      var carAt = function (u) { return (path && !seg.stay) ? pointOn(ph.seg, u) : [data.stops[ph.seg].x, data.stops[ph.seg].y]; };
      var cam;
      if (reduce) cam = centreOf(ph.phase === "dwell" ? ph.stop : (ph.u < 0.5 ? ph.seg : ph.seg + 1));
      else if (ph.phase === "dwell") cam = centreOf(ph.stop);
      else if (seg.stay) { var A = centreOf(ph.seg), B = centreOf(ph.seg + 1), e = smooth(ph.u); cam = { cx: A.cx + (B.cx - A.cx) * e, cy: A.cy + (B.cy - A.cy) * e, w: A.w + (B.w - A.w) * e }; }
      else cam = J.cameraAt(data.stops, seg, ph, carAt, data.travelZoom);
      var W = stage.clientWidth || 1, H = stage.clientHeight || 1, aspect = W / H;
      cam = J.frameCamera(cam, W, H, ph, data.stops, seg, reduce);
      var vb = J.viewBoxFor(cam, aspect);
      svg.setAttribute("viewBox", vb.map(function (v) { return Math.round(v * 10) / 10; }).join(" "));

      if (car && !reduce) {
        var pos, ang = lastAng;
        if (ph.phase === "travel" && !seg.stay && path) {
          var a = pointOn(ph.seg, ph.u), b = pointOn(ph.seg, Math.min(1, ph.u + 0.004));
          pos = a; if (b[0] !== a[0] || b[1] !== a[1]) { ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI; lastAng = ang; }
        } else pos = parkedAt(ph.phase === "dwell" ? ph.stop : ph.seg);
        var sc = Math.max(0.55, cam.w / 1400);
        car.setAttribute("transform", "translate(" + pos[0].toFixed(1) + " " + pos[1].toFixed(1) + ") rotate(" + ang.toFixed(1) + ") scale(" + sc.toFixed(2) + ")");
      }

      segPaths.forEach(function (p, i) {
        if (!p) return;
        var off = i < ph.seg ? 0 : i > ph.seg ? 1000 : Math.round(1000 * (1 - (ph.phase === "travel" ? ph.u : (ph.stop === ph.seg ? 0 : 1))));
        p.style.strokeDashoffset = off;
        p.classList.toggle("route--done", i < ph.seg);
      });
      var active = J.activeStop(ph, seg);
      stopEls.forEach(function (el, i) { if (el) el.classList.toggle("is-active", i === active); });
      copies.forEach(function (c, i) { c.classList.toggle("is-on", i === active); });
      dots.forEach(function (d, i) { var near = ph.phase === "dwell" ? ph.stop : (ph.u < 0.5 ? ph.seg : ph.seg + 1); d.classList.toggle("is-active", i === near); if (i === near) d.setAttribute("aria-current", "step"); else d.removeAttribute("aria-current"); });
      if (hint) hint.style.opacity = clamp(1 - m.progress * 12, 0, 1);
      root.style.setProperty("--jy-progress", m.progress.toFixed(4));
    }

    var onScroll = function () { if (!ticking) { ticking = true; (win.requestAnimationFrame || function (f) { f(); })(render); } };
    win.addEventListener("scroll", onScroll, { passive: true });
    win.addEventListener("resize", onScroll);
    render();
  };

  if (typeof window !== "undefined") {
    window.EasyJourney = J;
    if (typeof document !== "undefined" && document.readyState !== "loading" && document.getElementById) J.init(document, window);
    else if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", function () { J.init(document, window); });
  }
})();
