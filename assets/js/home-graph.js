/*
 * Home page graph: Vincent Garreau's particles.js 2.0.0.
 * The library is loaded immediately before this configuration in
 * _layouts/default.html.
 *
 * Built-in "repulse" mode moves connected particles away from the cursor,
 * rather than cutting an eraser-shaped hole in the edges.
 */
(() => {
  "use strict";

  if (!document.getElementById("home-graph-particles") ||
      typeof window.particlesJS !== "function") return;

  const reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  window.particlesJS("home-graph-particles", {
    particles: {
      number: {
        value: 145,
        density: { enable: true, value_area: 800 }
      },
      color: { value: "#393939" },
      shape: {
        type: "circle",
        stroke: { width: 0, color: "#393939" }
      },
      opacity: {
        value: 0.57,
        random: false,
        anim: { enable: false }
      },
      size: {
        value: 2.3,
        random: true,
        anim: { enable: false }
      },
      line_linked: {
        enable: true,
        distance: 122,
        color: "#444444",
        opacity: 0.30,
        width: 1
      },
      move: {
        enable: !reduceMotion,
        speed: 0.8,
        direction: "none",
        random: false,
        straight: false,
        out_mode: "out",
        bounce: false,
        attract: { enable: false, rotateX: 600, rotateY: 1200 }
      }
    },
    interactivity: {
      detect_on: "canvas",
      events: {
        onhover: { enable: !reduceMotion, mode: "repulse" },
        onclick: { enable: false, mode: "push" },
        resize: true
      },
      modes: {
        repulse: { distance: 135, duration: 0.4 }
      }
    },
    retina_detect: true
  });
})();
