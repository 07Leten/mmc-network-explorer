(() => {
  "use strict";

  const DATASETS = window.MMC_DATASETS;
  const requested = new URLSearchParams(location.search).get("cancer");
  const DS = DATASETS.find((d) => d.id === requested && d.available) || DATASETS.find((d) => d.available);

  setupPicker();
  loadScript(DS.file).then(() => start(window.MMC_DATA[DS.id]));

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = resolve;
      el.onerror = reject;
      document.body.appendChild(el);
    });
  }

  function setupPicker() {
    const button = document.getElementById("picker-button");
    const menu = document.getElementById("picker-menu");
    document.getElementById("picker-current").innerHTML = `${DS.short}<span class="code">${DS.code}</span>`;
    menu.innerHTML = DATASETS.map(
      (d) => `<li role="option" data-id="${d.id}" aria-selected="${d.id === DS.id}" aria-disabled="${!d.available}">
        <span class="organ">${d.organ}</span><span class="code">${d.code}</span>
        <span class="cancer">${d.cancer}</span>${d.available ? "" : '<span class="soon">Coming soon</span>'}</li>`,
    ).join("");
    const close = () => {
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    };
    button.addEventListener("click", (ev) => {
      ev.stopPropagation();
      menu.hidden = !menu.hidden;
      button.setAttribute("aria-expanded", String(!menu.hidden));
    });
    menu.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const li = ev.target.closest("li");
      if (!li || li.getAttribute("aria-disabled") === "true") return;
      close();
      if (li.dataset.id !== DS.id) location.search = `?cancer=${li.dataset.id}`;
    });
    document.addEventListener("click", close);
    document.addEventListener("keydown", (ev) => ev.key === "Escape" && close());
  }

  function start(D) {
    const NS = "http://www.w3.org/2000/svg";

    const MODULE_COLOR = {
      8: "#244766",
      7: "#3f8f8a",
      4: "#b7633c",
      6: "#8a6b9e",
      1: "#7b9478",
      9: "#9c5f6e",
      0: "#4e7fa7",
      2: "#c17b4a",
      3: "#c89c49",
      5: "#5e8c8a",
    };
    const EDGE_TONE = {
      pos: ["#a6bccf", "#3f6f97"],
      neg: ["#dfb3a0", "#b0582f"],
      ctx: ["#d2cbbd", "#8f877a"],
    };
    const GENE_PRESETS = (DS.presets && DS.presets.genes) || [];
    const MODULE_PRESETS = (DS.presets && DS.presets.modules) || [];
    const GENE_EDGE_LIMIT = 5;
    const REP_GENES = 12;
    const REP_EDGES = 3;
    const LABEL_LIMIT = 14;

    const MODULES = new Map(D.modules.map((m) => [m.id, m]));
    const MODULE_ORDER = D.modules.map((m) => m.id);
    const GENE_SYMBOLS = Object.keys(D.genes).sort();

    const state = {
      mode: "gene",
      genes: ((DS.initial && DS.initial.genes) || []).filter((s) => D.genes[s]),
      modules: (DS.initial && DS.initial.modules) || MODULE_PRESETS.slice(0, 1),
      focus: null,
      seenFocus: false,
    };

    const view = {
      graph: { nodes: [], edges: [], byId: new Map(), adj: new Map() },
      cam: { x: 0, y: 0, k: 1 },
      camAnim: null,
      trans: null,
      hover: null,
      pointer: null,
      lastClick: { id: null, t: 0 },
      nodeEls: new Map(),
      edgeEls: new Map(),
      raf: 0,
    };

    const $ = (id) => document.getElementById(id);
    const host = $("network");
    const tip = $("tip");

    // ---------- helpers ----------

    function esc(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }

    function svg(tag, attrs = {}) {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    }

    function hash(str, seed = 0) {
      let h = 2166136261 ^ seed;
      for (let i = 0; i < str.length; i += 1) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return ((h >>> 0) % 100000) / 100000;
    }

    function clamp(v, lo, hi) {
      return Math.max(lo, Math.min(hi, v));
    }

    function ease(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function colorOf(module) {
      return MODULE_COLOR[module] || "#8c969e";
    }

    function tint(hex, amount) {
      const v = parseInt(hex.slice(1), 16);
      const mix = (c) => Math.round(c * amount + 255 * (1 - amount));
      return `rgb(${mix(v >> 16)},${mix((v >> 8) & 255)},${mix(v & 255)})`;
    }

    function moduleName(id) {
      const m = MODULES.get(id);
      return m ? m.name : `Module ${id}`;
    }

    function sci(x) {
      if (x == null || !Number.isFinite(x) || x <= 0) return "—";
      const e = Math.floor(Math.log10(x));
      if (e >= -1) return x.toPrecision(2);
      return `${(x / Math.pow(10, e)).toFixed(1)} × 10<sup>−${-e}</sup>`;
    }

    function signed(w, sign) {
      return `${sign < 0 ? "−" : "+"}${w.toFixed(3)}`;
    }

    function morphLabel(id) {
      const m = D.morphs[id];
      return (m && m.pathology) || id;
    }

    function shorten(text, n) {
      return text.length > n ? `${text.slice(0, n - 1)}…` : text;
    }

    let morphIndex = null;
    function genesOfMorph(id) {
      if (!morphIndex) {
        morphIndex = new Map();
        for (const [gene, rows] of Object.entries(D.cross)) {
          for (const [m, w, s] of rows) {
            if (!morphIndex.has(m)) morphIndex.set(m, []);
            morphIndex.get(m).push([gene, w, s]);
          }
        }
        for (const rows of morphIndex.values()) rows.sort((a, b) => b[1] - a[1]);
      }
      return morphIndex.get(id) || [];
    }

    // ---------- queries ----------

    function geneNode(symbol) {
      return { id: symbol, kind: "gene", module: D.genes[symbol].module, r: 10 };
    }

    function morphNode(id) {
      return { id, kind: "morph", module: D.morphs[id].module, r: 7 };
    }

    function contextEdges(nodes, edges, withGenes) {
      for (const [a, b, w] of D.morphEdges) {
        if (nodes.has(a) && nodes.has(b)) edges.push({ a, b, w, sign: 0, kind: "morph" });
      }
      if (!withGenes) return;
      for (const [a, b, w] of D.geneEdges) {
        if (nodes.has(a) && nodes.has(b) && nodes.get(a).kind === "gene" && nodes.get(b).kind === "gene") {
          edges.push({ a, b, w, sign: 0, kind: "gene" });
        }
      }
    }

    function queryGenes(symbols) {
      const nodes = new Map();
      const edges = [];
      const summary = [];
      for (const symbol of symbols) {
        nodes.set(symbol, geneNode(symbol));
        const kept = (D.cross[symbol] || []).slice(0, GENE_EDGE_LIMIT);
        const byModule = new Map();
        let total = 0;
        for (const [m, w, sign] of kept) {
          if (!nodes.has(m)) nodes.set(m, morphNode(m));
          edges.push({ a: symbol, b: m, w, sign, kind: "cross" });
          const mod = D.morphs[m].module;
          byModule.set(mod, (byModule.get(mod) || 0) + w);
          total += w;
        }
        let best = null;
        for (const [mod, w] of byModule) if (!best || w > best.w) best = { mod, w };
        summary.push({ gene: symbol, module: best ? best.mod : null, pct: best ? best.w / total : 0, n: kept.length });
      }
      contextEdges(nodes, edges, true);
      return finishGraph(nodes, edges, { summary });
    }

    function rankGenes(moduleSet) {
      const ranked = [];
      for (const [gene, info] of Object.entries(D.genes)) {
        if (!moduleSet.has(info.module)) continue;
        const hits = (D.cross[gene] || []).filter(([m]) => D.morphs[m] && moduleSet.has(D.morphs[m].module));
        ranked.push({ gene, score: info.z || 0, hits });
      }
      ranked.sort((a, b) => b.score - a.score);
      return ranked;
    }

    function queryModules(ids) {
      const set = new Set(ids);
      const nodes = new Map();
      const edges = [];
      for (const [id, m] of Object.entries(D.morphs)) {
        if (set.has(m.module)) nodes.set(id, morphNode(id));
      }
      const reps = rankGenes(set).slice(0, REP_GENES);
      for (const rep of reps) {
        nodes.set(rep.gene, geneNode(rep.gene));
        for (const [m, w, sign] of rep.hits.slice(0, REP_EDGES)) edges.push({ a: rep.gene, b: m, w, sign, kind: "cross" });
      }
      contextEdges(nodes, edges, false);
      return finishGraph(nodes, edges, { reps: reps.map((r) => r.gene) });
    }

    function finishGraph(nodeMap, edges, extra) {
      const nodes = [...nodeMap.values()];
      const adj = new Map(nodes.map((n) => [n.id, new Set([n.id])]));
      const strength = new Map();
      for (const e of edges) {
        adj.get(e.a).add(e.b);
        adj.get(e.b).add(e.a);
        if (e.kind === "cross") strength.set(e.b, (strength.get(e.b) || 0) + e.w);
      }
      for (const n of nodes) {
        if (n.kind === "morph") n.r = 6.5 + 3.5 * clamp((strength.get(n.id) || 0) / 0.2, 0, 1);
      }
      return { nodes, edges, byId: nodeMap, adj, ...extra };
    }

    // ---------- layout ----------

    function layout(graph, previous) {
      const nodes = graph.nodes;
      const genes = nodes.filter((n) => n.kind === "gene");
      const ringR = genes.length > 1 ? 130 + genes.length * 22 : 0;
      genes.forEach((n, i) => {
        const p = previous.get(n.id);
        if (p) {
          n.x = p.x;
          n.y = p.y;
          return;
        }
        const a = (i / Math.max(genes.length, 1)) * Math.PI * 2 + hash(n.id) * 0.6;
        n.x = Math.cos(a) * ringR;
        n.y = Math.sin(a) * ringR;
      });
      for (const n of nodes) {
        if (n.kind !== "morph") continue;
        const p = previous.get(n.id);
        if (p) {
          n.x = p.x;
          n.y = p.y;
          continue;
        }
        const anchors = [...graph.adj.get(n.id)].map((id) => graph.byId.get(id)).filter((m) => m.kind === "gene");
        const jitterA = hash(n.id) * Math.PI * 2;
        const jitterR = 50 + hash(n.id, 7) * 50;
        if (anchors.length) {
          const cx = anchors.reduce((s, m) => s + m.x, 0) / anchors.length;
          const cy = anchors.reduce((s, m) => s + m.y, 0) / anchors.length;
          n.x = cx + Math.cos(jitterA) * jitterR;
          n.y = cy + Math.sin(jitterA) * jitterR;
        } else {
          const a = (MODULE_ORDER.indexOf(n.module) / MODULE_ORDER.length) * Math.PI * 2;
          n.x = Math.cos(a) * 200 + Math.cos(jitterA) * jitterR;
          n.y = Math.sin(a) * 200 + Math.sin(jitterA) * jitterR;
        }
      }

      const links = graph.edges.map((e) => ({
        s: graph.byId.get(e.a),
        t: graph.byId.get(e.b),
        rest: e.kind === "morph" ? 70 : e.kind === "gene" ? 150 : 155,
        k: e.kind === "cross" ? 0.05 : 0.07,
      }));
      for (const n of nodes) {
        n.vx = 0;
        n.vy = 0;
      }
      const steps = nodes.length > 120 ? 260 : 360;
      for (let it = 0; it < steps; it += 1) {
        const alpha = 1 - it / steps;
        for (let i = 0; i < nodes.length; i += 1) {
          const a = nodes[i];
          for (let j = i + 1; j < nodes.length; j += 1) {
            const b = nodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) {
              dx = hash(a.id + b.id) - 0.5;
              dy = hash(b.id + a.id) - 0.5;
              d2 = dx * dx + dy * dy;
            }
            const d = Math.sqrt(d2);
            let f = (4200 / Math.max(d2, 36)) * alpha;
            const minD = a.r + b.r + (a.kind === "gene" && b.kind === "gene" ? 60 : 30);
            if (d < minD) f += (minD - d) * 0.5;
            const fx = (dx / d) * f;
            const fy = (dy / d) * f;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }
        for (const l of links) {
          const dx = l.t.x - l.s.x;
          const dy = l.t.y - l.s.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = (d - l.rest) * l.k * alpha;
          const fx = (dx / d) * f;
          const fy = (dy / d) * f;
          l.s.vx += fx;
          l.s.vy += fy;
          l.t.vx -= fx;
          l.t.vy -= fy;
        }
        for (const n of nodes) {
          n.vx -= n.x * 0.008 * alpha;
          n.vy -= n.y * 0.008 * alpha;
          n.vx *= 0.6;
          n.vy *= 0.6;
          n.x += clamp(n.vx, -24, 24);
          n.y += clamp(n.vy, -24, 24);
        }
      }
      if (!nodes.length) return;
      if (nodes.filter((n) => n.kind === "morph").length <= LABEL_LIMIT) separateLabels(nodes);
      const cx = nodes.reduce((s, n) => s + n.x, 0) / nodes.length;
      const cy = nodes.reduce((s, n) => s + n.y, 0) / nodes.length;
      for (const n of nodes) {
        n.tx = n.x - cx;
        n.ty = n.y - cy;
      }
    }

    function separateLabels(nodes) {
      const boxes = nodes.map((n) => {
        const text = n.kind === "gene" ? n.id : shorten(morphLabel(n.id), 34);
        const w = Math.max(n.r * 2, text.length * (n.kind === "gene" ? 7.4 : 5.8) + 12);
        return { n, hw: w / 2, top: n.r + 4, bottom: n.r + 20 };
      });
      for (let it = 0; it < 200; it += 1) {
        let moved = false;
        for (let i = 0; i < boxes.length; i += 1) {
          const a = boxes[i];
          for (let j = i + 1; j < boxes.length; j += 1) {
            const b = boxes[j];
            const ox = a.hw + b.hw - Math.abs(b.n.x - a.n.x);
            const oy = Math.min(a.n.y + a.bottom, b.n.y + b.bottom) - Math.max(a.n.y - a.top, b.n.y - b.top);
            if (ox <= 0 || oy <= 0) continue;
            moved = true;
            if (ox < oy * 2.5) {
              const s = Math.sign(b.n.x - a.n.x) || 1;
              a.n.x -= (s * ox) / 4;
              b.n.x += (s * ox) / 4;
            } else {
              const s = Math.sign(b.n.y - a.n.y) || 1;
              a.n.y -= (s * oy) / 4;
              b.n.y += (s * oy) / 4;
            }
          }
        }
        if (!moved) break;
      }
    }

    // ---------- stage ----------

    let svgRoot;
    let world;
    let edgeLayer;
    let ringLayer;
    let nodeLayer;
    let labelLayer;
    let ring;
    let emptyState;

    function ensureStage() {
      if (svgRoot) return;
      svgRoot = svg("svg", { role: "img", "aria-label": "MPG–MRM network" });
      const defs = svg("defs");
      const filter = svg("filter", { id: "lift", x: "-60%", y: "-60%", width: "220%", height: "220%" });
      filter.appendChild(svg("feDropShadow", { dx: 0, dy: 3, stdDeviation: 2.6, "flood-color": "#183247", "flood-opacity": 0.3 }));
      defs.appendChild(filter);
      svgRoot.appendChild(defs);
      world = svg("g");
      edgeLayer = svg("g");
      ringLayer = svg("g");
      nodeLayer = svg("g");
      labelLayer = svg("g");
      ring = svg("circle", { r: 16, fill: "rgba(200,156,73,0.14)", stroke: "#c89c49", "stroke-width": 1.6 });
      ring.style.opacity = 0;
      ring.style.transition = "opacity 220ms ease";
      ringLayer.appendChild(ring);
      world.append(edgeLayer, ringLayer, nodeLayer);
      svgRoot.append(world, labelLayer);
      host.appendChild(svgRoot);

      emptyState = document.createElement("div");
      emptyState.className = "empty-state";
      emptyState.hidden = true;
      host.appendChild(emptyState);

      host.addEventListener("pointerdown", onPointerDown);
      host.addEventListener("pointermove", onPointerMove);
      host.addEventListener("pointerup", onPointerUp);
      host.addEventListener("pointercancel", () => {
        view.pointer = null;
        host.classList.remove("dragging");
      });
      host.addEventListener("pointerleave", () => {
        if (!view.pointer) setHover(null);
      });
      host.addEventListener("wheel", onWheel, { passive: false });
      new ResizeObserver(schedule).observe(host);
    }

    function makeNodeEl(n) {
      const g = svg("g", { class: "n" });
      const color = colorOf(n.module);
      let shape;
      if (n.kind === "gene") {
        shape = svg("polygon", { points: "0,-10 10,0 0,10 -10,0", fill: color, stroke: "#fff", "stroke-width": 1.8, "stroke-linejoin": "round" });
      } else {
        shape = svg("circle", { r: n.r, fill: tint(color, 0.3), stroke: color, "stroke-width": 1.8 });
      }
      g.appendChild(shape);
      const label = svg("text", { class: `net-label ${n.kind}`, "text-anchor": "middle" });
      label.textContent = n.kind === "gene" ? n.id : shorten(morphLabel(n.id), 34);
      for (const el of [g, label]) {
        el.style.opacity = 0;
        el.style.transition = "opacity 240ms ease";
      }
      nodeLayer.appendChild(g);
      labelLayer.appendChild(label);
      return { g, shape, label };
    }

    function makeEdgeEl(e) {
      const width = e.kind !== "cross" ? 1.2 : e.w >= 0.05 ? 2.8 : e.w >= 0.02 ? 2 : 1.3;
      const line = svg("line", {
        "stroke-width": width,
        "stroke-linecap": "round",
        "stroke-dasharray": `0.01 ${(3.2 + width * 1.5).toFixed(1)}`,
      });
      line.style.opacity = 0;
      line.style.transition = "opacity 240ms ease, stroke 240ms ease";
      edgeLayer.appendChild(line);
      return line;
    }

    function retire(el) {
      el.style.opacity = 0;
      setTimeout(() => el.remove(), 260);
    }

    function edgeKey(e) {
      return `${e.kind}:${e.a}|${e.b}`;
    }

    function setGraph(graph) {
      ensureStage();
      const old = view.graph;
      const previous = new Map();
      const shown = new Map();
      for (const n of old.nodes) {
        previous.set(n.id, { x: n.tx, y: n.ty });
        shown.set(n.id, { x: n.px, y: n.py });
      }
      layout(graph, previous);

      for (const n of graph.nodes) {
        const s = shown.get(n.id);
        if (s) {
          n.sx = s.x;
          n.sy = s.y;
        } else {
          const anchor = [...graph.adj.get(n.id)].find((id) => shown.has(id));
          const p = anchor ? shown.get(anchor) : { x: n.tx, y: n.ty };
          n.sx = p.x;
          n.sy = p.y;
        }
        n.px = n.sx;
        n.py = n.sy;
        n.lift = 0;
      }

      const keepNodes = new Set(graph.nodes.map((n) => n.id));
      for (const [id, el] of view.nodeEls) {
        if (!keepNodes.has(id)) {
          retire(el.g);
          retire(el.label);
          view.nodeEls.delete(id);
        }
      }
      for (const n of graph.nodes) {
        let el = view.nodeEls.get(n.id);
        if (!el) {
          el = makeNodeEl(n);
          view.nodeEls.set(n.id, el);
        } else if (n.kind === "morph") {
          el.shape.setAttribute("r", n.r);
        }
        n.el = el;
      }

      const keepEdges = new Set(graph.edges.map(edgeKey));
      for (const [key, line] of view.edgeEls) {
        if (!keepEdges.has(key)) {
          retire(line);
          view.edgeEls.delete(key);
        }
      }
      for (const e of graph.edges) {
        const key = edgeKey(e);
        if (!view.edgeEls.has(key)) view.edgeEls.set(key, makeEdgeEl(e));
        e.el = view.edgeEls.get(key);
        e.s = graph.byId.get(e.a);
        e.t = graph.byId.get(e.b);
      }

      view.graph = graph;
      view.hover = null;
      view.trans = { start: performance.now(), dur: 720 };
      emptyState.hidden = graph.nodes.length > 0;
      void host.offsetWidth;
      applyEmphasis();
      fitAll();
    }

    function size() {
      return { w: host.clientWidth, h: host.clientHeight };
    }

    function toScreen(x, y) {
      const { w, h } = size();
      const { cam } = view;
      return { x: (x - cam.x) * cam.k + w / 2, y: (y - cam.y) * cam.k + h / 2 };
    }

    function toWorld(sx, sy) {
      const { w, h } = size();
      const { cam } = view;
      return { x: (sx - w / 2) / cam.k + cam.x, y: (sy - h / 2) / cam.k + cam.y };
    }

    function animateCam(target, dur = 700) {
      view.camAnim = { from: { ...view.cam }, to: target, start: performance.now(), dur };
      schedule();
    }

    function fitAll() {
      const nodes = view.graph.nodes;
      if (!nodes.length) {
        animateCam({ x: 0, y: 0, k: 1 });
        return;
      }
      const { w, h } = size();
      const xs = nodes.map((n) => n.tx);
      const ys = nodes.map((n) => n.ty);
      const minX = Math.min(...xs) - 30;
      const maxX = Math.max(...xs) + 30;
      const minY = Math.min(...ys) - 24;
      const maxY = Math.max(...ys) + 40;
      const pad = 36;
      const k = clamp(Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY)), 0.3, 1.5);
      animateCam({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, k });
    }

    function focusCamera(id) {
      const g = view.graph;
      const n = g.byId.get(id);
      if (!n) return;
      const { w, h } = size();
      let hw = 60;
      let hh = 50;
      for (const nid of g.adj.get(id)) {
        const m = g.byId.get(nid);
        hw = Math.max(hw, Math.abs(m.tx - n.tx) + 90);
        hh = Math.max(hh, Math.abs(m.ty - n.ty) + 40);
      }
      const k = clamp(Math.min((w / 2 - 20) / hw, (h / 2 - 24) / hh), 0.3, 1.9);
      animateCam({ x: n.tx, y: n.ty, k }, 760);
    }

    function zoomBy(factor) {
      const k = clamp(view.cam.k * factor, 0.2, 4);
      animateCam({ x: view.cam.x, y: view.cam.y, k }, 260);
    }

    function schedule() {
      if (!view.raf) view.raf = requestAnimationFrame(frame);
    }

    function frame(now) {
      view.raf = 0;
      let busy = false;
      const { w, h } = size();

      if (view.camAnim) {
        const a = view.camAnim;
        const t = clamp((now - a.start) / a.dur, 0, 1);
        const e = ease(t);
        const zf = Math.log(a.from.k);
        const zt = Math.log(a.to.k);
        view.cam = {
          x: a.from.x + (a.to.x - a.from.x) * e,
          y: a.from.y + (a.to.y - a.from.y) * e,
          k: Math.exp(zf + (zt - zf) * e),
        };
        if (t < 1) busy = true;
        else view.camAnim = null;
      }

      let mix = 1;
      if (view.trans) {
        const t = clamp((now - view.trans.start) / view.trans.dur, 0, 1);
        mix = ease(t);
        if (t < 1) busy = true;
        else view.trans = null;
      }

      const { cam } = view;
      world.setAttribute("transform", `translate(${w / 2},${h / 2}) scale(${cam.k}) translate(${-cam.x},${-cam.y})`);

      const g = view.graph;
      const showMorphLabels = cam.k >= 0.62 && g.nodes.filter((n) => n.kind === "morph").length <= LABEL_LIMIT;
      for (const n of g.nodes) {
        const target = n.id === view.hover ? 1 : 0;
        n.lift += (target - n.lift) * 0.2;
        if (Math.abs(target - n.lift) > 0.01) busy = true;
        else n.lift = target;
        const bob = n.id === view.hover ? Math.sin(now / 420) * 1.3 : 0;
        if (n.id === view.hover) busy = true;
        n.px = n.sx + (n.tx - n.sx) * mix;
        n.py = n.sy + (n.ty - n.sy) * mix;
        const scale = 1 + 0.2 * n.lift;
        const dy = -3.5 * n.lift + bob;
        n.el.g.setAttribute("transform", `translate(${n.px},${n.py + dy}) scale(${scale})`);
        if (n.lift > 0.02) n.el.g.setAttribute("filter", "url(#lift)");
        else n.el.g.removeAttribute("filter");
        const s = toScreen(n.px, n.py + dy);
        const off = (n.kind === "gene" ? 10 : n.r) * cam.k * scale + 13;
        n.el.label.setAttribute("x", s.x.toFixed(1));
        n.el.label.setAttribute("y", (s.y + off).toFixed(1));
        n.labelAuto = n.kind === "gene" || showMorphLabels;
      }
      for (const e of g.edges) {
        e.el.setAttribute("x1", e.s.px);
        e.el.setAttribute("y1", e.s.py);
        e.el.setAttribute("x2", e.t.px);
        e.el.setAttribute("y2", e.t.py);
      }
      const f = state.focus && g.byId.get(state.focus);
      if (f) {
        ring.setAttribute("cx", f.px);
        ring.setAttribute("cy", f.py);
        ring.setAttribute("r", (f.kind === "gene" ? 10 : f.r) + 7);
      }
      updateLabels();
      if (busy) schedule();
    }

    function activeNode() {
      return view.hover || state.focus;
    }

    function applyEmphasis() {
      const g = view.graph;
      const active = activeNode();
      const near = active ? g.adj.get(active) : null;
      for (const n of g.nodes) {
        n.el.g.style.opacity = !near || near.has(n.id) ? 1 : 0.14;
      }
      for (const e of g.edges) {
        const tone = EDGE_TONE[e.kind !== "cross" ? "ctx" : e.sign > 0 ? "pos" : "neg"];
        const incident = active && (e.a === active || e.b === active);
        e.el.style.stroke = incident ? tone[1] : tone[0];
        e.el.style.opacity = !active ? 1 : incident ? 1 : 0.08;
      }
      ring.style.opacity = state.focus && g.byId.has(state.focus) ? 1 : 0;
      updateLabels();
      schedule();
    }

    function updateLabels() {
      const g = view.graph;
      const active = activeNode();
      const near = active ? g.adj.get(active) : null;
      for (const n of g.nodes) {
        let op;
        if (near) op = near.has(n.id) ? 1 : n.kind === "gene" ? 0.14 : 0;
        else op = n.labelAuto === false ? 0 : 1;
        const v = String(op);
        if (n.el.label.style.opacity !== v) n.el.label.style.opacity = v;
      }
    }

    // ---------- pointer ----------

    function local(ev) {
      const r = host.getBoundingClientRect();
      return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

    function hit(p) {
      const wp = toWorld(p.x, p.y);
      const nodes = view.graph.nodes;
      let best = null;
      let bestD = Infinity;
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const n = nodes[i];
        const r = (n.kind === "gene" ? 10 : n.r) * (1 + 0.2 * n.lift) + 4 / view.cam.k;
        const d = Math.hypot(n.px - wp.x, n.py - wp.y);
        if (d < r && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    }

    function onPointerDown(ev) {
      if (ev.button !== 0 || ev.target.closest("button")) return;
      const p = local(ev);
      const node = hit(p);
      view.pointer = { id: ev.pointerId, x: p.x, y: p.y, cam: { ...view.cam }, node, moved: false };
      host.setPointerCapture(ev.pointerId);
    }

    function onPointerMove(ev) {
      const p = local(ev);
      const ptr = view.pointer;
      if (ptr) {
        const dx = p.x - ptr.x;
        const dy = p.y - ptr.y;
        if (!ptr.moved && Math.hypot(dx, dy) > 4) {
          ptr.moved = true;
          host.classList.add("dragging");
          hideTip();
        }
        if (!ptr.moved) return;
        view.camAnim = null;
        if (ptr.node) {
          const wp = toWorld(p.x, p.y);
          const n = ptr.node;
          n.sx = n.tx = wp.x;
          n.sy = n.ty = wp.y;
        } else {
          view.cam.x = ptr.cam.x - dx / view.cam.k;
          view.cam.y = ptr.cam.y - dy / view.cam.k;
        }
        schedule();
        return;
      }
      const n = hit(p);
      setHover(n ? n.id : null);
      if (n) showTip(n, ev.clientX, ev.clientY);
    }

    function onPointerUp(ev) {
      const ptr = view.pointer;
      view.pointer = null;
      host.classList.remove("dragging");
      if (!ptr || ptr.moved) return;
      const now = performance.now();
      if (ptr.node) {
        const id = ptr.node.id;
        if (view.lastClick.id === id && now - view.lastClick.t < 320) {
          view.lastClick = { id: null, t: 0 };
          explore(id);
          return;
        }
        view.lastClick = { id, t: now };
        focusNode(id);
      } else if (state.focus) {
        state.focus = null;
        applyEmphasis();
        renderDetails();
        fitAll();
      }
      const n = hit(local(ev));
      setHover(n ? n.id : null);
    }

    function onWheel(ev) {
      if (!view.graph.nodes.length) return;
      ev.preventDefault();
      const p = local(ev);
      const before = toWorld(p.x, p.y);
      const { w, h } = size();
      const k = clamp(view.cam.k * Math.exp(-ev.deltaY * 0.0015), 0.2, 4);
      view.camAnim = null;
      view.cam = { k, x: before.x - (p.x - w / 2) / k, y: before.y - (p.y - h / 2) / k };
      schedule();
    }

    function setHover(id) {
      if (view.hover === id) return;
      view.hover = id;
      host.classList.toggle("over-node", Boolean(id));
      if (!id) hideTip();
      applyEmphasis();
    }

    function edgesOf(id) {
      return view.graph.edges.filter((e) => e.kind === "cross" && (e.a === id || e.b === id)).sort((a, b) => b.w - a.w);
    }

    function showTip(n, cx, cy) {
      const color = colorOf(n.module);
      const rows = edgesOf(n.id).slice(0, 4).map((e) => {
        const other = e.a === n.id ? e.b : e.a;
        const name = n.kind === "gene" ? shorten(morphLabel(other), 30) : other;
        return `<div class="tip-row"><span>${esc(name)}</span><span>${signed(e.w, e.sign)}</span></div>`;
      });
      let head;
      if (n.kind === "gene") {
        const desc = D.genes[n.id].desc;
        head = `<strong class="mono">${esc(n.id)}</strong><div class="tip-meta">MPG · ${esc(moduleName(n.module))}</div>${desc ? `<div class="tip-meta">${esc(shorten(desc, 70))}</div>` : ""}`;
      } else {
        const m = D.morphs[n.id];
        head = `<strong>${esc(morphLabel(n.id))}</strong><div class="tip-meta">MRM · ${esc(moduleName(n.module))}</div><div class="tip-meta">${m.group ? esc(m.group) : esc(n.id)}</div>`;
      }
      tip.innerHTML = head + (rows.length ? `<div class="tip-rows">${rows.join("")}</div>` : "");
      tip.style.setProperty("--swatch", color);
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      const x = cx + 16 + r.width > window.innerWidth ? cx - r.width - 16 : cx + 16;
      const y = cy + 16 + r.height > window.innerHeight ? cy - r.height - 12 : cy + 16;
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    }

    function hideTip() {
      tip.hidden = true;
    }

    // ---------- actions ----------

    function refresh() {
      state.focus = null;
      hideTip();
      const graph = state.mode === "gene" ? queryGenes(state.genes) : queryModules(state.modules);
      setGraph(graph);
      renderControls();
      renderStageHead();
      renderLegend();
      renderDetails();
      renderTable();
    }

    function focusNode(id) {
      if (!view.graph.byId.has(id)) return;
      state.focus = id;
      state.seenFocus = true;
      applyEmphasis();
      renderDetails();
      focusCamera(id);
    }

    function explore(id) {
      if (D.genes[id]) {
        state.mode = "gene";
        state.genes = [id];
      } else if (D.morphs[id]) {
        state.mode = "module";
        state.modules = [D.morphs[id].module];
      }
      refresh();
    }

    function openModule(id) {
      state.mode = "module";
      state.modules = [id];
      refresh();
    }

    function addGene(symbol) {
      if (!D.genes[symbol]) return false;
      state.mode = "gene";
      if (!state.genes.includes(symbol)) state.genes.push(symbol);
      refresh();
      return true;
    }

    // ---------- controls ----------

    const search = $("search");
    const results = $("search-results");
    const note = $("search-note");
    let matches = [];
    let activeMatch = -1;

    function renderMatches() {
      const q = search.value.trim().toUpperCase();
      note.hidden = true;
      if (!q) {
        results.hidden = true;
        return;
      }
      const prefix = GENE_SYMBOLS.filter((s) => s.startsWith(q));
      const inner = GENE_SYMBOLS.filter((s) => !s.startsWith(q) && s.includes(q));
      matches = prefix.concat(inner).slice(0, 12);
      activeMatch = matches.length && matches[0] === q ? 0 : -1;
      results.innerHTML = matches
        .map((s, i) => {
          const mod = D.genes[s].module;
          return `<li role="option" data-symbol="${esc(s)}" aria-selected="${i === activeMatch}"><span class="diamond" style="background:${colorOf(mod)}"></span>${esc(s)}<small>${esc(shorten(moduleName(mod), 22))}</small></li>`;
        })
        .join("");
      results.hidden = !matches.length;
    }

    function choose(symbol) {
      search.value = "";
      results.hidden = true;
      addGene(symbol);
    }

    search.addEventListener("input", renderMatches);
    search.addEventListener("keydown", (ev) => {
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        if (!matches.length) return;
        ev.preventDefault();
        activeMatch = (activeMatch + (ev.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
        [...results.children].forEach((li, i) => li.setAttribute("aria-selected", i === activeMatch));
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        const q = search.value.trim().toUpperCase();
        if (!q) return;
        if (D.genes[q]) choose(q);
        else if (activeMatch >= 0) choose(matches[activeMatch]);
        else {
          results.hidden = true;
          note.textContent = `${q} is not in this network.`;
          note.hidden = false;
        }
      } else if (ev.key === "Escape") {
        results.hidden = true;
      }
    });
    search.addEventListener("blur", () => setTimeout(() => (results.hidden = true), 150));
    results.addEventListener("mousedown", (ev) => {
      const li = ev.target.closest("li");
      if (li) {
        ev.preventDefault();
        choose(li.dataset.symbol);
      }
    });

    document.querySelectorAll(".tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        if (state.mode === tab.dataset.mode) return;
        state.mode = tab.dataset.mode;
        refresh();
      });
    });

    $("clear").addEventListener("click", () => {
      if (state.mode === "gene") state.genes = [];
      else state.modules = [];
      note.hidden = true;
      refresh();
    });

    $("zoom-in").addEventListener("click", () => zoomBy(1.3));
    $("zoom-out").addEventListener("click", () => zoomBy(1 / 1.3));
    $("zoom-fit").addEventListener("click", () => (state.focus ? focusCamera(state.focus) : fitAll()));
    $("export-svg").addEventListener("click", exportSvg);
    $("export-csv").addEventListener("click", exportCsv);

    function renderControls() {
      document.querySelectorAll(".tab").forEach((tab) => tab.setAttribute("aria-selected", String(tab.dataset.mode === state.mode)));
      $("gene-tools").hidden = state.mode !== "gene";
      $("module-tools").hidden = state.mode !== "module";

      $("gene-chips").innerHTML = state.genes
        .map((s) => `<span class="chip"><span class="diamond" style="background:${colorOf(D.genes[s].module)}"></span>${esc(s)}<button type="button" data-remove="${esc(s)}" aria-label="Remove ${esc(s)}">×</button></span>`)
        .join("");
      $("gene-presets").innerHTML = GENE_PRESETS.map(
        (s) => `<button type="button" class="preset${state.genes.includes(s) ? " on" : ""}" data-gene="${s}">${s}</button>`,
      ).join("");
      $("module-list").innerHTML = D.modules
        .map(
          (m) => `<button type="button" class="module-option${state.modules.includes(m.id) ? " on" : ""}" data-module="${m.id}" style="--swatch:${colorOf(m.id)}">
            <span class="swatch"></span><span class="name">${esc(m.name)}</span><span class="count">${m.nMorph} · ${m.nGene}</span></button>`,
        )
        .join("");
    }

    $("gene-chips").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-remove]");
      if (!b) return;
      state.genes = state.genes.filter((s) => s !== b.dataset.remove);
      refresh();
    });
    $("gene-presets").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-gene]");
      if (!b) return;
      const s = b.dataset.gene;
      if (state.genes.includes(s)) {
        state.genes = state.genes.filter((g) => g !== s);
        refresh();
      } else addGene(s);
    });
    $("module-list").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-module]");
      if (!b) return;
      const id = Number(b.dataset.module);
      state.modules = state.modules.includes(id) ? state.modules.filter((m) => m !== id) : state.modules.concat(id);
      refresh();
    });

    function renderStageHead() {
      const g = view.graph;
      const nMorph = g.nodes.filter((n) => n.kind === "morph").length;
      const nGene = g.nodes.length - nMorph;
      const nCross = g.edges.filter((e) => e.kind === "cross").length;
      let kicker = "Network";
      let title = "No selection";
      if (g.nodes.length && state.mode === "gene") {
        kicker = `MPG query · ${nGene} gene${nGene > 1 ? "s" : ""} · ${nMorph} MRMs · ${nCross} edges`;
        title = state.genes.length > 4 ? `${state.genes.slice(0, 4).join(", ")} +${state.genes.length - 4}` : state.genes.join(", ");
      } else if (g.nodes.length) {
        kicker = `Module view · ${nMorph} MRMs · ${nGene} representative MPGs`;
        title = state.modules.length === 1 ? moduleName(state.modules[0]) : `${state.modules.length} modules`;
      }
      $("stage-kicker").textContent = kicker;
      $("stage-title").textContent = title;

      if (!g.nodes.length) {
        const genePresets = GENE_PRESETS.slice(0, 3).map((s) => `<button type="button" class="preset" data-gene="${s}">${s}</button>`);
        const modPresets = MODULE_PRESETS.map((id) => `<button type="button" class="preset" data-module="${id}">${esc(moduleName(id))}</button>`);
        emptyState.innerHTML = `<p>Select an MPG or a module</p><div class="presets">${genePresets.concat(modPresets).join("")}</div>`;
      }
    }

    function renderLegend() {
      const g = view.graph;
      const mods = [...new Set(g.nodes.map((n) => n.module))].sort((a, b) => MODULE_ORDER.indexOf(a) - MODULE_ORDER.indexOf(b));
      const dotted = (c, w) => `<svg width="30" height="8"><line x1="3" y1="4" x2="27" y2="4" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-dasharray="0.01 ${3.2 + w * 1.5}"/></svg>`;
      const parts = [
        `<span class="legend-item"><svg width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="#e9e4da" stroke="#64717c" stroke-width="1.5"/></svg>MRM</span>`,
        `<span class="legend-item"><svg width="14" height="14"><polygon points="7,1 13,7 7,13 1,7" fill="#64717c"/></svg>MPG</span>`,
        `<span class="legend-sep"></span>`,
        `<span class="legend-item">${dotted(EDGE_TONE.pos[1], 2)}Positive</span>`,
        `<span class="legend-item">${dotted(EDGE_TONE.neg[1], 2)}Negative</span>`,
        `<span class="legend-item">${dotted(EDGE_TONE.ctx[1], 1.4)}Within-modality</span>`,
      ];
      if (mods.length) {
        parts.push(`<span class="legend-sep"></span>`);
        for (const m of mods) parts.push(`<span class="legend-item"><span class="dot" style="background:${colorOf(m)}"></span>${esc(moduleName(m))}</span>`);
      }
      $("legend").innerHTML = parts.join("");
    }

    host.addEventListener("click", (ev) => {
      const b = ev.target.closest(".empty-state [data-gene], .empty-state [data-module]");
      if (!b) return;
      if (b.dataset.gene) addGene(b.dataset.gene);
      else openModule(Number(b.dataset.module));
    });

    // ---------- details ----------

    function rankItem(id, w, sign, max, extra = "") {
      const isGene = Boolean(D.genes[id]);
      const mod = isGene ? D.genes[id].module : D.morphs[id].module;
      const mark = isGene ? `<span class="diamond" style="background:${colorOf(mod)}"></span>` : `<span class="dot" style="background:${colorOf(mod)}"></span>`;
      const name = isGene ? `<span style="font-family:var(--mono)">${esc(id)}</span>` : `<span>${esc(morphLabel(id))}</span>`;
      return `<li data-act="pick" data-id="${esc(id)}" title="${esc(isGene ? id : `${morphLabel(id)} · ${id}`)}">
        <span class="label">${mark}${name}</span>
        <span class="value ${sign < 0 ? "neg" : "pos"}">${signed(w, sign)}</span>
        <span class="bar"><i style="width:${((w / max) * 100).toFixed(1)}%;background:${colorOf(mod)}"></i></span>${extra}</li>`;
    }

    function moduleCard(id, reps) {
      const m = MODULES.get(id);
      const repHtml = reps
        .map((s) => `<button type="button" class="gene-pill" data-act="pick" data-id="${esc(s)}"><span class="diamond" style="background:${colorOf(D.genes[s].module)}"></span>${esc(s)}</button>`)
        .join("");
      return `<article class="module-card" style="--swatch:${colorOf(id)}">
        <p class="detail-kicker">Module ${id}</p>
        <h3>${esc(m.name)}</h3>
        <p class="stat-line">${m.nMorph} MRMs · ${m.nGene} MPGs · overlap ${esc(m.overlap)} · FDR ${sci(m.fdr)}</p>
        <p class="sub-head">MRMs</p>
        <div class="terms">${m.terms.map((t) => `<span class="term">${esc(t)}</span>`).join("") || `<span class="term">—</span>`}</div>
        <p class="sub-head">Representative MPGs</p>
        <div class="gene-cloud">${repHtml}</div>
        <p class="sub-head">Hallmark genes</p>
        <p class="hallmark">${m.hallmark.map(esc).join(" ")}</p>
      </article>`;
    }

    function viewStats() {
      const g = view.graph;
      const count = (kind) => g.edges.filter((e) => e.kind === kind).length;
      const nMorph = g.nodes.filter((n) => n.kind === "morph").length;
      return `<section class="detail-section"><p class="sub-head">Current view</p><dl class="kv">
        <dt>MPGs</dt><dd>${g.nodes.length - nMorph}</dd>
        <dt>MRMs</dt><dd>${nMorph}</dd>
        <dt>MPG–MRM edges</dt><dd>${count("cross")}</dd>
        <dt>MRM–MRM edges</dt><dd>${count("morph")}</dd>
        ${state.mode === "gene" ? `<dt>MPG–MPG edges</dt><dd>${count("gene")}</dd>` : ""}
      </dl></section>`;
    }

    function nodeDetails(id) {
      const g = view.graph;
      const n = g.byId.get(id);
      const color = colorOf(n.module);
      const inView = edgesOf(id);
      const back = `<button type="button" class="back" data-act="back">← Overview</button>`;
      const tag = `<button type="button" class="module-tag" data-act="module" data-module="${n.module}" style="--swatch:${color}"><span class="dot" style="background:${color}"></span>${esc(moduleName(n.module))}</button>`;
      let head;
      let actions = [];
      let overall;
      if (n.kind === "gene") {
        const desc = D.genes[id].desc;
        head = `<p class="detail-kicker"><span class="diamond" style="background:${color}"></span>MPG</p>
          <h3 class="detail-title mono">${esc(id)}</h3>${desc ? `<p class="detail-sub">${esc(desc)}</p>` : ""}${tag}`;
        if (!(state.mode === "gene" && state.genes.length === 1 && state.genes[0] === id)) actions.push(`<button type="button" class="action" data-act="explore" data-id="${esc(id)}">Explore gene</button>`);
        if (state.mode === "gene" && !state.genes.includes(id)) actions.push(`<button type="button" class="action ghost" data-act="add" data-id="${esc(id)}">Add to query</button>`);
        const top = (D.cross[id] || []).slice(0, 6);
        overall = top.length ? { title: "Strongest MRMs", rows: top } : null;
      } else {
        const m = D.morphs[id];
        head = `<p class="detail-kicker"><span class="dot" style="background:${color}"></span>MRM</p>
          <h3 class="detail-title">${esc(morphLabel(id))}</h3>
          <p class="detail-sub">${m.group ? esc(m.group) : esc(id)}</p>${tag}`;
        if (!(state.mode === "module" && state.modules.length === 1 && state.modules[0] === n.module)) actions.push(`<button type="button" class="action" data-act="module" data-module="${n.module}">Open module</button>`);
        const top = genesOfMorph(id).slice(0, 6);
        overall = top.length ? { title: "Strongest MPGs", rows: top } : null;
      }
      const sections = [`<section class="detail-section">${back}${head}${actions.length ? `<div class="actions">${actions.join("")}</div>` : ""}</section>`];
      if (inView.length) {
        const max = Math.max(...inView.map((e) => e.w));
        const rows = inView.map((e) => rankItem(e.a === id ? e.b : e.a, e.w, e.sign, max)).join("");
        sections.push(`<section class="detail-section"><p class="sub-head">In view</p><ul class="rank-list">${rows}</ul></section>`);
      }
      if (overall) {
        const max = overall.rows[0][1];
        const rows = overall.rows.map(([other, w, s]) => rankItem(other, w, s, max)).join("");
        sections.push(`<section class="detail-section"><p class="sub-head">${overall.title}</p><ul class="rank-list">${rows}</ul></section>`);
      }
      return sections.join("");
    }

    function renderDetails() {
      const g = view.graph;
      const panel = $("details");
      if (state.focus && g.byId.has(state.focus)) {
        panel.innerHTML = nodeDetails(state.focus);
        return;
      }
      if (!g.nodes.length) {
        panel.innerHTML = `${guideHtml(true)}<section class="detail-section"><p class="sub-head">Refined modules</p>
          <ul class="rank-list">${D.modules
            .map((m) => `<li data-act="module" data-module="${m.id}"><span class="label"><span class="dot" style="background:${colorOf(m.id)}"></span><span>${esc(m.name)}</span></span><span class="value" style="color:var(--faint)">${m.nMorph} · ${m.nGene}</span></li>`)
            .join("")}</ul></section>`;
        return;
      }
      if (state.mode === "gene") {
        const rows = g.summary
          .map((s) => {
            const c = colorOf(s.module);
            return `<li data-act="pick" data-id="${esc(s.gene)}">
              <span class="label"><span class="diamond" style="background:${colorOf(D.genes[s.gene].module)}"></span><span style="font-family:var(--mono)">${esc(s.gene)}</span></span>
              <span class="value">${Math.round(s.pct * 100)}%</span>
              <span class="bar"><i style="width:${(s.pct * 100).toFixed(1)}%;background:${c}"></i></span>
              <span style="grid-column:1/-1;font-size:11.5px;color:var(--muted)">${s.module === null ? "—" : esc(moduleName(s.module))}</span></li>`;
          })
          .join("");
        panel.innerHTML = `${guideHtml()}<section class="detail-section"><p class="sub-head">Dominant module</p><ul class="rank-list">${rows}</ul></section>${viewStats()}`;
        return;
      }
      const cards = state.modules
        .slice()
        .sort((a, b) => MODULE_ORDER.indexOf(a) - MODULE_ORDER.indexOf(b))
        .map((id) => moduleCard(id, state.modules.length === 1 ? g.reps : rankGenes(new Set([id])).slice(0, REP_GENES).map((r) => r.gene)))
        .join("");
      panel.innerHTML = `${guideHtml()}<section class="detail-section">${cards}</section>${viewStats()}`;
    }

    function guideHtml(empty = false) {
      if (empty || !state.seenFocus) {
        return `<div class="guide">
          <h3>Select a node or module of interest</h3>
          <ol>
            <li>Choose an organ, then search an MPG or a refined module.</li>
            <li>Hover over a node in the network to preview its strongest associations.</li>
            <li>Click a node to centre it and open its details here; double-click to expand it.</li>
          </ol>
        </div>`;
      }
      return `<div class="guide compact"><span class="pulse"></span><p>Click any node in the network to inspect it.</p></div>`;
    }

    $("details").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-act]");
      if (!b) return;
      const { act, id } = b.dataset;
      if (act === "back") {
        state.focus = null;
        applyEmphasis();
        renderDetails();
        fitAll();
      } else if (act === "pick") {
        if (view.graph.byId.has(id)) focusNode(id);
        else explore(id);
      } else if (act === "explore") explore(id);
      else if (act === "add") addGene(id);
      else if (act === "module") openModule(Number(b.dataset.module));
    });

    // ---------- table ----------

    function crossRows() {
      return view.graph.edges.filter((e) => e.kind === "cross").sort((a, b) => b.w - a.w);
    }

    function renderTable() {
      const rows = crossRows();
      const body = $("edge-rows");
      if (!rows.length) {
        body.innerHTML = `<tr class="empty-row"><td colspan="5">No associations in the current view</td></tr>`;
        return;
      }
      const max = Math.max(...rows.map((e) => e.w));
      body.innerHTML = rows
        .map((e) => {
          const m = D.morphs[e.b];
          const tone = e.sign > 0 ? "pos" : "neg";
          return `<tr>
            <td><button type="button" class="link cell mono" data-id="${esc(e.a)}"><span class="diamond" style="background:${colorOf(D.genes[e.a].module)}"></span>${esc(e.a)}</button></td>
            <td><button type="button" class="link" data-id="${esc(e.b)}">${esc(morphLabel(e.b))}<span class="feature-id">${esc(m.group || e.b)}</span></button></td>
            <td><span class="cell"><span class="dot" style="background:${colorOf(m.module)}"></span>${esc(moduleName(m.module))}</span></td>
            <td class="${tone}">${e.sign > 0 ? "Positive" : "Negative"}</td>
            <td class="num"><span class="weight"><i class="${tone}" style="width:${Math.round((e.w / max) * 80)}px"></i>${e.w.toFixed(3)}</span></td>
          </tr>`;
        })
        .join("");
    }

    $("edge-rows").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-id]");
      if (!b) return;
      focusNode(b.dataset.id);
      $("explorer").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    // ---------- module overview ----------

    function renderModuleGrid() {
      $("module-grid").innerHTML = D.modules
        .map(
          (m) => `<button type="button" class="module-tile" data-module="${m.id}" style="--swatch:${colorOf(m.id)}">
          <span class="tile-id">Module ${m.id}</span>
          <h3>${esc(m.name)}</h3>
          <p class="stat-line">${m.nMorph} MRMs · ${m.nGene} MPGs</p>
          <p class="stat-line">Overlap ${esc(m.overlap)} · FDR ${sci(m.fdr)}</p>
          <div class="terms">${m.terms.map((t) => `<span class="term">${esc(t)}</span>`).join("")}</div>
          <span class="open">Explore →</span>
        </button>`,
        )
        .join("");
    }

    $("module-grid").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-module]");
      if (!b) return;
      openModule(Number(b.dataset.module));
      $("explorer").scrollIntoView({ behavior: "smooth", block: "start" });
    });

    // ---------- export ----------

    function download(name, text, type) {
      const url = URL.createObjectURL(new Blob([text], { type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function fileStem() {
      if (state.mode === "gene") return `mmc_bowel_genes_${state.genes.join("-") || "none"}`;
      return `mmc_bowel_modules_${state.modules.join("-") || "none"}`;
    }

    function exportSvg() {
      if (!svgRoot) return;
      const { w, h } = size();
      const clone = svgRoot.cloneNode(true);
      clone.setAttribute("xmlns", NS);
      clone.setAttribute("width", w);
      clone.setAttribute("height", h);
      clone.setAttribute("viewBox", `0 0 ${w} ${h}`);
      clone.querySelectorAll("[style]").forEach((el) => {
        const op = el.style.opacity;
        const stroke = el.style.stroke;
        el.removeAttribute("style");
        if (op !== "") el.setAttribute("opacity", op);
        if (stroke) el.setAttribute("stroke", stroke);
      });
      const style = svg("style");
      style.textContent = `.net-label{font-family:Helvetica,Arial,sans-serif;paint-order:stroke;stroke:#fff;stroke-width:4px;stroke-linejoin:round}
        .net-label.gene{font-family:Menlo,Consolas,monospace;font-size:11.5px;font-weight:600;fill:#1f2a33}
        .net-label.morph{font-size:10.5px;fill:#44515b}`;
      clone.insertBefore(style, clone.firstChild);
      clone.insertBefore(svg("rect", { width: "100%", height: "100%", fill: "#ffffff" }), style.nextSibling);
      download(`${fileStem()}.svg`, new XMLSerializer().serializeToString(clone), "image/svg+xml");
    }

    function exportCsv() {
      const rows = crossRows();
      const lines = [["mpg", "mrm", "uni_dimension", "module_id", "module_annotation", "sign", "weight"].join(",")];
      for (const e of rows) {
        const m = D.morphs[e.b];
        const cells = [e.a, e.b, m.group || "", m.module, moduleName(m.module), e.sign > 0 ? "positive" : "negative", e.w];
        lines.push(cells.map((c) => (/[",]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(","));
      }
      download(`${fileStem()}.csv`, `${lines.join("\n")}\n`, "text/csv");
    }

    // ---------- init ----------

    $("metrics").innerHTML = [
      ["MRMs", D.stats.morph],
      ["MPGs", D.stats.gene],
      ["MMC edges", D.stats.cross],
      ["Refined modules", D.stats.modules],
    ]
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v.toLocaleString("en-US")}</dd></div>`)
      .join("");

    document.title = `MMC Network Explorer · ${DS.short}`;
    $("dataset-title").textContent = DS.organ;
    $("dataset-code").textContent = DS.code;
    $("foot-dataset").textContent = `${DS.cancer} (${DS.code})`;

    document.querySelectorAll('.paper-link[aria-disabled="true"]').forEach((a) => a.addEventListener("click", (ev) => ev.preventDefault()));
    $("copy-bib").addEventListener("click", () => {
      const text = $("bibtex").textContent;
      const done = () => {
        $("copy-bib").textContent = "Copied";
        setTimeout(() => ($("copy-bib").textContent = "Copy BibTeX"), 1600);
      };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done);
        return;
      }
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
      done();
    });

    renderModuleGrid();
    refresh();
  }
})();
