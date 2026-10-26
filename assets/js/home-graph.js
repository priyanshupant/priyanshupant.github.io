/*
 * Minimal interactive graph for the home page.
 * No libraries, external data, or animation running when idle.
 */
(() => {
  "use strict";
  const canvas = document.getElementById("home-graph-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const pointer = { x: 0, y: 0, inside: false };
  let width = 0, height = 0, radius = 62, strength = 0;
  let vertices = [], edges = [], frameId = null;

  function seededRandom(seed) {
    return () => {
      seed |= 0;
      seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function buildGraph() {
    const random = seededRandom(20261026);
    const columns = Math.max(5, Math.round(width / 62));
    const rows = Math.max(3, Math.round(height / 56));
    vertices = [];
    edges = [];

    // A reproducible, slightly irregular geometric graph.
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        if (random() < 0.06) continue;
        const x = (c + 0.40 + (r % 2) * 0.20 + (random() - .5) * .40) * width / columns;
        const y = (r + 0.5 + (random() - .5) * .50) * height / rows;
        vertices.push({ x, y, dx: 0, dy: 0 });
      }
    }

    const candidates = [];
    const limit = Math.max(width / columns, height / rows) * 1.62;
    for (let i = 0; i < vertices.length; i++) {
      for (let j = i + 1; j < vertices.length; j++) {
        const dx = vertices[i].x - vertices[j].x;
        const dy = vertices[i].y - vertices[j].y;
        const distance2 = dx * dx + dy * dy;
        if (distance2 < limit * limit) candidates.push({ i, j, distance2 });
      }
    }

    candidates.sort((a, b) => a.distance2 - b.distance2);
    const degree = Array(vertices.length).fill(0);
    for (const edge of candidates) {
      if (degree[edge.i] < 3 && degree[edge.j] < 3) {
        edges.push([edge.i, edge.j]);
        degree[edge.i]++;
        degree[edge.j]++;
      }
    }
    radius = Math.min(88, Math.max(46, width * .075));
  }

  function segment(a, b) {
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }

  function drawEdge(a, b, cutRadius) {
    if (cutRadius <= 1) {
      segment(a, b);
      return;
    }

    // Split every edge where it crosses the circular cursor clearing.
    const dx = b.x - a.x, dy = b.y - a.y;
    const fx = a.x - pointer.x, fy = a.y - pointer.y;
    const aa = dx * dx + dy * dy;
    const bb = 2 * (fx * dx + fy * dy);
    const cc = fx * fx + fy * fy - cutRadius * cutRadius;
    const discriminant = bb * bb - 4 * aa * cc;

    if (aa === 0 || discriminant <= 0) {
      // Both endpoints can still be inside the clearing.
      if (fx * fx + fy * fy > cutRadius * cutRadius) segment(a, b);
      return;
    }

    const root = Math.sqrt(discriminant);
    const enter = Math.max(0, (-bb - root) / (2 * aa));
    const exit = Math.min(1, (-bb + root) / (2 * aa));
    if (enter >= exit) {
      segment(a, b);
      return;
    }
    if (enter > 0) {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(a.x + dx * enter, a.y + dy * enter);
    }
    if (exit < 1) {
      ctx.moveTo(a.x + dx * exit, a.y + dy * exit);
      ctx.lineTo(b.x, b.y);
    }
  }

  function render() {
    frameId = null;
    if (document.hidden || !width || !height) return;

    const goal = pointer.inside ? 1 : 0;
    strength = reduceMotion ? goal : strength + (goal - strength) * .16;
    if (Math.abs(goal - strength) < .003) strength = goal;

    const drawingRadius = radius * strength;
    let stillMoving = Math.abs(goal - strength) > .003;

    ctx.clearRect(0, 0, width, height);
    for (const vertex of vertices) {
      let targetX = 0, targetY = 0;
      if (pointer.inside && strength > 0) {
        const vx = vertex.x - pointer.x, vy = vertex.y - pointer.y;
        const distance = Math.hypot(vx, vy);
        const range = radius * 1.7;
        if (distance < range && distance > .001) {
          const push = 17 * Math.pow(1 - distance / range, 2) * strength;
          targetX = vx / distance * push;
          targetY = vy / distance * push;
        }
      }
      if (reduceMotion) {
        vertex.dx = targetX;
        vertex.dy = targetY;
      } else {
        vertex.dx += (targetX - vertex.dx) * .17;
        vertex.dy += (targetY - vertex.dy) * .17;
      }
      if (Math.abs(targetX - vertex.dx) + Math.abs(targetY - vertex.dy) > .02) stillMoving = true;
    }

    ctx.strokeStyle = "rgba(55, 60, 64, 0.31)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [i, j] of edges) {
      const v = vertices[i], w = vertices[j];
      drawEdge(
        { x: v.x + v.dx, y: v.y + v.dy },
        { x: w.x + w.dx, y: w.y + w.dy },
        drawingRadius
      );
    }
    ctx.stroke();

    ctx.fillStyle = "rgba(43, 48, 53, 0.72)";
    ctx.beginPath();
    for (const vertex of vertices) {
      const x = vertex.x + vertex.dx, y = vertex.y + vertex.dy;
      if (drawingRadius > 1 && Math.hypot(x - pointer.x, y - pointer.y) < drawingRadius) continue;
      ctx.moveTo(x + 1.8, y);
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
    }
    ctx.fill();

    if (stillMoving) schedule();
  }

  function schedule() {
    if (frameId === null && !document.hidden) frameId = requestAnimationFrame(render);
  }

  function resize() {
    const box = canvas.getBoundingClientRect();
    width = box.width;
    height = box.height;
    if (!width || !height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildGraph();
    schedule();
  }

  canvas.addEventListener("pointermove", event => {
    if (event.pointerType === "touch") return;
    const box = canvas.getBoundingClientRect();
    pointer.x = event.clientX - box.left;
    pointer.y = event.clientY - box.top;
    pointer.inside = true;
    schedule();
  }, { passive: true });
  canvas.addEventListener("pointerleave", () => {
    pointer.inside = false;
    schedule();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    } else if (!document.hidden) schedule();
  });

  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener("resize", resize);
  resize();
})();
