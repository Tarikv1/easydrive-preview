/* Fahrschule Easy Drive – progressive enhancement. No dependencies, no tracking. */
(function () {
  "use strict";
  var ED = {};
  var FIELDS = ["name", "phone", "email", "city", "course", "language", "message"];

  ED.composeMessage = function (fields, labels) {
    var lines = [labels.intro];
    FIELDS.forEach(function (k) {
      var v = (fields[k] || "").toString().trim();
      if (v) lines.push(labels[k] + ": " + v);
    });
    return lines.join("\n");
  };
  ED.waUrl = function (number, text) { return "https://wa.me/" + number + "?text=" + encodeURIComponent(text); };
  ED.mailtoUrl = function (email, subject, text) { return "mailto:" + email + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(text); };
  // The launch offer ends with its last day (local time); this is the same cut-off the build uses (promoContext in scripts/lib.mjs).
  ED.promoExpired = function (untilIso, now) { return (now || new Date()) > new Date(untilIso + "T23:59:59"); };

  ED.init = function (doc, win) {
    // A page built during the launch offer still shows the right variant once the date has passed.
    var promoUntil = doc.body && doc.body.getAttribute("data-promo-until");
    if (promoUntil && ED.promoExpired(promoUntil)) {
      var launch = doc.querySelectorAll("[data-promo-launch]");
      var done = doc.querySelectorAll("[data-promo-done]");
      for (var i = 0; i < launch.length; i++) launch[i].hidden = true;
      for (var j = 0; j < done.length; j++) done[j].hidden = false;
    }
    var nav = doc.getElementById("nav");
    var toggle = doc.getElementById("navToggle");
    var links = doc.getElementById("navLinks");
    if (toggle && links) {
      toggle.addEventListener("click", function () {
        var open = links.classList.toggle("is-open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
      links.addEventListener("click", function (e) {
        if (e.target && e.target.tagName === "A") { links.classList.remove("is-open"); toggle.setAttribute("aria-expanded", "false"); }
      });
    }
    if (nav) win.addEventListener("scroll", function () { nav.classList.toggle("is-scrolled", win.scrollY > 8); }, { passive: true });

    var year = doc.getElementById("year");
    if (year) year.textContent = String(new Date().getFullYear());

    var holder = doc.getElementById("mapHolder");
    var mapBtn = holder && holder.querySelector(".mapload");
    if (holder && mapBtn) mapBtn.addEventListener("click", function () {
      var f = doc.createElement("iframe");
      f.title = "Karte Fahrschule Easy Drive"; f.loading = "lazy"; f.src = holder.getAttribute("data-map-src");
      f.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
      holder.innerHTML = ""; holder.appendChild(f);
    });

    var form = doc.getElementById("anfrage");
    if (form) {
      var labels = JSON.parse(form.getAttribute("data-labels") || "{}");
      var number = form.getAttribute("data-wa"); var email = form.getAttribute("data-mail");
      var read = function () {
        var f = {};
        FIELDS.forEach(function (k) { var el = form.querySelector("[name=" + k + "]"); f[k] = el ? el.value : ""; });
        return f;
      };
      var wa = doc.getElementById("sendWa"); var mail = doc.getElementById("sendMail");
      if (wa) wa.addEventListener("click", function (e) {
        e.preventDefault(); if (!form.reportValidity()) return;
        win.open(ED.waUrl(number, ED.composeMessage(read(), labels)), "_blank", "noopener");
      });
      if (mail) mail.addEventListener("click", function (e) {
        e.preventDefault(); if (!form.reportValidity()) return;
        win.location.href = ED.mailtoUrl(email, labels.intro, ED.composeMessage(read(), labels));
      });
      form.addEventListener("submit", function (e) { e.preventDefault(); if (wa) wa.click(); });
    }
  };

  if (typeof window !== "undefined") {
    window.EasyDrive = ED;
    if (typeof document !== "undefined" && document.readyState !== "loading" && document.getElementById) ED.init(document, window);
    else if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", function () { ED.init(document, window); });
  }
})();
