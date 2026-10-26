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

  const smallScreen = window.matchMedia &&
    window.matchMedia("(max-width: 660px)").matches;

  const reduceMotion = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  window.particlesJS("home-graph-particles", {
    particles: {
      number: {
        value: smallScreen ? 65 : 112,
        density: { enable: true, value_area: 1050 }
      },
      color: { value: "#393939" },
      shape: {
        type: "circle",
        stroke: { width: 0, color: "#393939" }
      },
      opacity: {
        value: 0.38,
        random: false,
        anim: { enable: false }
      },
      size: {
        value: 2.1,
        random: true,
        anim: { enable: false }
      },
      line_linked: {
        enable: true,
        distance: 134,
        color: "#505050",
        opacity: 0.19,
        width: 1
      },
      move: {
        enable: !reduceMotion,
        speed: 0.65,
        direction: "none",
        random: false,
        straight: false,
        out_mode: "out",
        bounce: false,
        attract: { enable: false, rotateX: 600, rotateY: 1200 }
      }
    },
    interactivity: {
      detect_on: "window",
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
