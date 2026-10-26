/*
 * Subtle interactive geometric graph for Priyanshu's homepage.
 * Inspired by open-source linked-particle / mouse-repulsion demos.
 *
 * Unlike the previous version, this DOES NOT erase a circle from the lines:
 * vertices physically move, links stretch with them, and springs restore
 * the mesh once the pointer leaves.
 *
 * Self-contained: no dependencies, tracking, or network requests.
 */
(() => {
  "use strict";

  const canvas = document.getElementById("home-graph-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pointer = { x: -1000, y: -1000, active: false };
  let width = 0;
  let height = 0;
  let radius = 125;
  let nodes = [];
  let links = [];
  let frame = 0;
  let inView = true;

  // Predictable distribution so the graph does not change on every refresh.
  function randomGenerator(seed) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function buildMesh() {
    const rand = randomGenerator(146021);
    const spacing = Math.max(48, Math.min(72, width / 17));
    nodes = [];
    links = [];

    // A gently irregular, staggered lattice; no harsh regular grid.
    const rows = Math.ceil(height / spacing) + 1;
    const cols = Math.ceil(width / spacing) + 1;
    for (let row = 0; row <= rows; row++) {
      for (let col = -1; col <= cols; col++) {
        if (rand() < 0.075) continue;
        const x = (col + (row % 2) * .5 + (rand() - .5) * .42) * spacing;
        const y = (row + (rand() - .5) * .48) * spacing;
        if (x < -12 || x > width + 12 || y < -12 || y > height + 12) continue;
        nodes.push({ x, y, homeX: x, homeY: y, vx: 0, vy: 0 });
      }
    }

    const possible = [];
    const maxLinkLength = spacing * 1.62;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const d2 = dx * dx + dy * dy;
        if (d2 < maxLinkLength * maxLinkLength) {
          possible.push({ a: i, b: j, rest: Math.sqrt(d2) });
        }
      }
    }
    possible.sort((a, b) => a.rest - b.rest);
    const degree = new Uint8Array(nodes.length);
    for (const edge of possible) {
      if (degree[edge.a] >= 4 || degree[edge.b] >= 4) continue;
      links.push(edge);
      degree[edge.a]++;
      degree[edge.b]++;
    }
    radius = Math.max(74, Math.min(130, width * .115));
  }

  function render() {
    ctx.clearRect(0, 0, width, height);
    ctx.lineCap = "round";
    ctx.lineWidth = .9;

    // Every line is always attached to its moving endpoints.
    // Very overstretched links fade naturally, instead of being cut by a disk.
    for (const link of links) {
      const a = nodes[link.a], b = nodes[link.b];
      const stretched = Math.hypot(a.x - b.x, a.y - b.y) / link.rest;
      const opacity = .30 * Math.max(.09, Math.min(1, (1.92 - stretched) / .50));
      ctx.strokeStyle = "rgba(38,44,49," + opacity.toFixed(3) + ")";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    ctx.beginPath();
    for (const node of nodes) {
      ctx.moveTo(node.x + 1.8, node.y);
      ctx.arc(node.x, node.y, 1.8, 0, Math.PI * 2);
    }
    ctx.fillStyle = "rgba(35,41,47,.68)";
    ctx.fill();
  }

  function animate() {
    frame = 0;
    if (!inView || document.hidden) return;

    let moving = false;
    if (!reducedMotion) {
      // Tension in adjacent edges makes the network respond as a mesh.
      for (const edge of links) {
        const a = nodes[edge.a], b = nodes[edge.b];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d < .01) continue;
        const force = (d - edge.rest) * .0019 / d;
        const fx = dx * force, fy = dy * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }

      for (const node of nodes) {
        // Home springs + damping make the mesh settle instead of jittering.
        node.vx += (node.homeX - node.x) * .021;
        node.vy += (node.homeY - node.y) * .021;

        if (pointer.active) {
          const dx = node.x - pointer.x;
          const dy = node.y - pointer.y;
          const dist = Math.hypot(dx, dy);
          if (dist < radius) {
            const falloff = Math.pow(1 - dist / radius, 2);
            const push = falloff * 3.0;
            // Fixed tiny direction if the cursor is exactly on a vertex.
            const ux = dist > .001 ? dx / dist : 1;
            const uy = dist > .001 ? dy / dist : 0;
            node.vx += ux * push;
            node.vy += uy * push;
          }
        }

        node.vx *= .82;
        node.vy *= .82;
        node.x += node.vx;
        node.y += node.vy;

        if (Math.abs(node.vx) + Math.abs(node.vy) > .018 ||
            Math.abs(node.x - node.homeX) + Math.abs(node.y - node.homeY) > .08) {
          moving = true;
        }
      }
    }
    render();
    if (moving) schedule();
  }

  function schedule() {
    if (!frame && inView && !document.hidden) frame = requestAnimationFrame(animate);
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    width = bounds.width;
    height = bounds.height;

    const scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    buildMesh();
    schedule();
  }

  function setPointer(e) {
    if (reducedMotion || e.pointerType === "touch") return;
    const bounds = canvas.getBoundingClientRect();
    pointer.x = e.clientX - bounds.left;
    pointer.y = e.clientY - bounds.top;
    pointer.active = true;
    schedule();
  }

  function releasePointer() {
    pointer.active = false;
    schedule();
  }

  canvas.addEventListener("pointerenter", setPointer, { passive: true });
  canvas.addEventListener("pointermove", setPointer, { passive: true });
  canvas.addEventListener("pointerleave", releasePointer);
  canvas.addEventListener("pointercancel", releasePointer);
  window.addEventListener("blur", releasePointer);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else if (!document.hidden) schedule();
  });

  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      inView = entries[0].isIntersecting;
      if (!inView && frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else if (inView) schedule();
    }, { threshold: 0.01 }).observe(canvas);
  }

  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener("resize", resize);

  resize();
})();
