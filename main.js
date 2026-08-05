/* ==========================================================================
   2. WIDGET
   ========================================================================== */
if (MINIMALIST) document.body.classList.add("minimal");

const $ = s => document.querySelector(s);
const svg = d3.select("#map"), css = getComputedStyle(document.documentElement);
const LO = css.getPropertyValue("--shade-lo").trim();
const HI = css.getPropertyValue("--shade-hi").trim();
const W = () => svg.node().clientWidth, H = () => svg.node().clientHeight;

const sea    = svg.append("rect").attr("class","sea");
const zoomG  = svg.append("g");
const landG  = zoomG.append("g");
const labelG = zoomG.append("g");
const graphG = svg.append("g").style("display","none");

const proj = d3.geoNaturalEarth1(), path = d3.geoPath(proj);

let setName = Object.keys(DATASETS)[0];
let values = {}, years = [], STEPS = 0;
let step = 0, mode = "yearly", view = "yearly", lastMap = "yearly";
let speed = 1, looping = false, timer = null, scale = 1;
let features = [], marks = [], ready = false, fitted = false;
let xScale = null, cursor = null;

// merge aliases; two keys landing on one country keep the larger value, never
// the sum — overlapping sources would double count
function loadSet(name){
  setName = name;
  const d = DATASETS[name];
  years = d3.range(d.years[0], d.years[1] + 1);
  STEPS = years.length * STEPS_PER_YEAR;
  values = {};
  for (const [k, series] of Object.entries(d.data)){
    const n = ALIASES[k] || k;
    if (!values[n]){ values[n] = { ...series }; continue; }
    for (const [y, v] of Object.entries(series))
      values[n][y] = values[n][y] == null ? v : Math.max(values[n][y], v);
  }
  step = Math.min(step, STEPS - 1);
  buildYears();
  if (ready) recomputeMarks();
}

const yearAt = s => years[Math.floor(s / STEPS_PER_YEAR)];
const raw    = (name, s) => values[name]?.[yearAt(s)];
const valueAt = (name, s) => { const v = raw(name, s); return v == null ? null : v / MODES[mode].div; };

const scaleMax = () => SCALE_MAX[mode] ??
  (d3.max(Object.values(values), s => d3.max(Object.values(s))) || 1) / MODES[mode].div;
// sqrt: linear leaves everything below the top country almost unshaded
const shade = v => d3.interpolateLab(LO, HI)(Math.sqrt(Math.min(v / scaleMax(), 1)));

/* ---- base map ----------------------------------------------------------- */
d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json").then(w => {
  features = topojson.feature(w, w.objects.countries).features
                     .filter(f => f.properties.name !== "Antarctica");
  landG.selectAll("path").data(features).join("path")
       .attr("class","country").attr("data-name", f => f.properties.name);
  ready = true;
  recomputeMarks();
  resize();
});

function recomputeMarks(){
  marks = features.filter(f => values[f.properties.name])
                  .map(f => ({ name:f.properties.name, ...labelPoint(f) }));
  if (fitted) marks.forEach(m => m.xy = anchor(m));
  const miss = Object.keys(values).filter(n => !marks.some(m => m.name === n));
  if (miss.length) console.warn("no map shape (add to ALIASES):", miss);
}

/* label goes at the pole of inaccessibility — the point furthest from the
   country's own coast. A centroid drops Norway into Sweden and Chile into
   Argentina. Grid search over the largest ring, refined twice. */
function labelPoint(f){
  const o = LABEL_OVERRIDES[f.properties.name];
  if (o) return { lonlat:o };
  const polys = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
  const ring = polys.map(p => p[0]).filter(r => r.length > 3)
                    .sort((a,b) => Math.abs(d3.geoArea({type:"Polygon",coordinates:[b]}))
                                 - Math.abs(d3.geoArea({type:"Polygon",coordinates:[a]})))[0];
  if (!ring) return { lonlat:d3.geoCentroid(f) };
  return { ring };
}

// resolved at draw time because it depends on the current projection.
// returns [x, y, room] — room = px to the nearest coast, used to size the label
function anchor(m){
  if (m.lonlat) return [...proj(m.lonlat), 30];
  const ring = m.ring.map(c => proj(c)).filter(p => p && isFinite(p[0]));
  if (ring.length < 4) return [0, 0, 0];
  const coast = ring.filter((_,i) => i % 2 === 0);
  const room = ([x,y]) => d3.min(coast, ([cx,cy]) => Math.hypot(x-cx, y-cy));
  let [x0,x1] = d3.extent(ring, p => p[0]), [y0,y1] = d3.extent(ring, p => p[1]);
  let s = Math.max(x1-x0, y1-y0) / 16, best = null, bestRoom = -1;
  for (let pass = 0; pass < 3; pass++){
    for (let x = x0; x <= x1; x += s) for (let y = y0; y <= y1; y += s){
      if (!d3.polygonContains(ring,[x,y])) continue;
      const r = room([x,y]); if (r > bestRoom){ bestRoom = r; best = [x,y]; }
    }
    if (!best) break;
    [x0,x1,y0,y1] = [best[0]-s, best[0]+s, best[1]-s, best[1]+s]; s /= 4;
  }
  return best ? [...best, bestRoom] : [...d3.polygonCentroid(ring), 0];
}

/* ---- layout ------------------------------------------------------------- */
function resize(){
  const w = W(), h = H(); if (!w || !h) return;
  svg.attr("viewBox",[0,0,w,h]);
  sea.attr("width",w).attr("height",h);
  proj.fitExtent([[8,8],[w-8,h-8]], {type:"Sphere"});
  landG.selectAll("path").attr("d", path);
  fitted = true;
  marks.forEach(m => m.xy = anchor(m));
  if (view.startsWith("graph")) buildGraph(view === "graph-all");
  update();
}
window.addEventListener("resize", resize);

svg.call(d3.zoom().scaleExtent([1,MAX_ZOOM]).on("zoom", e => {
  if (view.startsWith("graph")) return;
  scale = e.transform.k;
  zoomG.attr("transform", e.transform);
  landG.attr("stroke-width", .6 / scale);
  place();
}));

/* ---- repaint ------------------------------------------------------------ */
function update(){
  const y = yearAt(step), sub = step % STEPS_PER_YEAR + 1;
  $("#date").textContent = `${String(sub).padStart(2,"0")} / ${y}`;

  landG.selectAll("path").attr("fill", f => {
    const v = valueAt(f.properties.name, step);
    return v == null ? LO : shade(v);
  });

  const live = marks.filter(m => valueAt(m.name, step) != null);
  labelG.selectAll("g.label").data(live, d => d.name)
    .join(enter => {
      const g = enter.append("g").attr("class","label");
      g.append("circle").attr("class","dot").attr("r",1.6);
      g.append("text").attr("class","name").attr("text-anchor","middle").attr("y",-8);
      g.append("text").attr("class","value").attr("text-anchor","middle").attr("y",15);
      return g;
    })
    .call(g => {
      g.select(".name").text(d => d.name);
      g.select(".value").text(d => Math.round(valueAt(d.name, step)).toLocaleString());
    });
  place();

  if (cursor && xScale) cursor.attr("x1", xScale(step)).attr("x2", xScale(step));
  d3.selectAll(".year").attr("aria-current", d => String(d === y));
  paintLegend();
}

/* Labels live inside the zoom layer, so a plain scale(1) would already grow
   with the map 1:1. What's set here is a slower rate: the label grows with
   the country, but not as fast — 10x zoom reads as roughly 5x label size,
   and it reverses exactly on the way back out because it's a pure power
   curve (scale^ZOOM_POWER), invertible either direction.
     ZOOM_POWER = 1   -> label grows exactly as fast as the map (10x -> 10x)
     ZOOM_POWER = 0.7 -> 10x zoom -> ~5x label (10^0.7 ≈ 5.01) — set below
     ZOOM_POWER = 0   -> old behaviour, constant on-screen size
   NET_MIN/NET_MAX just stop the size going to zero or absurd at the extreme
   ends of the zoom range (1x-12x).
   Independent of all that, labels still shrink to fit narrow countries
   (NAME_ROOM), and below MIN_FIT of that room the name is dropped, leaving
   only the figure — this applies at every zoom level, not just zoomed out. */
const NAME_ROOM = 26, MIN_FIT = .62;
const ZOOM_POWER = .7, NET_MIN = .5, NET_MAX = 8;
function place(){
  labelG.selectAll("g.label").each(function(d){
    const [x, y, room = NAME_ROOM] = d.xy || [0, 0];
    const fit = Math.max(MIN_FIT, Math.min(1, (room * scale) / NAME_ROOM));
    const net = Math.max(NET_MIN, Math.min(NET_MAX, fit * Math.pow(scale, ZOOM_POWER)));
    d3.select(this)
      .attr("transform", `translate(${x},${y}) scale(${net / scale})`)
      .select(".name").style("display", room * scale < NAME_ROOM * MIN_FIT ? "none" : null);
  });
}

function paintLegend(){
  const ramp = $("#ramp"); if (!ramp) return;   // legend markup is commented out
  ramp.style.background = `linear-gradient(to right, ${LO}, ${HI})`;
  $("#legend-label").textContent = MODES[mode].label;
  $("#legend-max").textContent = Math.round(scaleMax()).toLocaleString();
}

/* ---- graph -------------------------------------------------------------- */
const PAD = { top:38, right:130, bottom:46, left:56 };
const LEAD = 6;
const TITLES = {
  "graph":     "Number of samples from sample data, per country",
  "graph-all": "Number of samples from sample data, all countries combined",
};

function buildGraph(all){
  graphG.selectAll("*").remove();
  const w = W(), h = H();
  const names = Object.keys(values);
  const series = names.map(n => ({ n, pts:d3.range(STEPS).map(s => valueAt(n,s) ?? 0) }));
  series.forEach(s => s.peak = d3.max(s.pts));

  const total = all ? { n:"All countries",
    pts:d3.range(STEPS).map(s => d3.sum(series, x => x.pts[s])) } : null;
  if (total) total.peak = d3.max(total.pts);

  const named = total ? [total] : series.slice().sort((a,b) => b.peak - a.peak).slice(0,LEAD);
  const lead = new Set(named.map(s => s.n));

  xScale = d3.scaleLinear().domain([0, STEPS-1]).range([PAD.left, w - PAD.right]);
  const y = d3.scaleLinear().domain([0, d3.max(series.concat(named), s => s.peak) || 1])
              .nice().range([h - PAD.bottom, PAD.top]);

  graphG.append("text").attr("class","gtitle").attr("x",PAD.left).attr("y",22)
        .text(TITLES[all ? "graph-all" : "graph"]);

  graphG.append("g").attr("class","axis").selectAll("g").data(y.ticks(5)).join("g")
    .call(g => g.append("line").attr("class","gridline")
      .attr("x1",PAD.left).attr("x2",w-PAD.right).attr("y1",y).attr("y2",y))
    .call(g => g.append("text").attr("x",PAD.left-8).attr("y",y)
      .attr("dy",".32em").attr("text-anchor","end").text(d3.format(",")));

  graphG.append("g").attr("class","axis").selectAll("text").data(years).join("text")
    .attr("x", d => xScale(years.indexOf(d) * STEPS_PER_YEAR))
    .attr("y", h - PAD.bottom + 16).attr("text-anchor","middle")
    .text((d,i) => i % 2 ? "" : d);

  // tallest first, so a shorter line paints over it instead of vanishing
  const line = d3.line().x((_,i) => xScale(i)).y(d => y(d));
  graphG.append("g").selectAll("path")
    .data(series.concat(total ? [total] : []).sort((a,b) => b.peak - a.peak))
    .join("path")
    .attr("class", s => "series" + (lead.has(s.n) ? " lead" : ""))
    // inline style: the sheet's grey beats a presentation attribute
    .style("stroke", s => lead.has(s.n) ? "var(--accent)" : null)
    .attr("d", s => line(s.pts));

  // spread the end labels apart, then push the column back inside the frame
  const ends = named.filter(s => s.peak > 0)
    .map(s => ({ n:s.n, y:y(s.pts[STEPS-1]) })).sort((a,b) => a.y - b.y);
  const gap = 12, top = PAD.top, bot = h - PAD.bottom;
  for (let i=1;i<ends.length;i++) ends[i].y = Math.max(ends[i].y, ends[i-1].y + gap);
  for (let i=ends.length-1;i>=0;i--)
    ends[i].y = Math.min(ends[i].y, i === ends.length-1 ? bot : ends[i+1].y - gap);
  for (let i=0;i<ends.length;i++) ends[i].y = Math.max(ends[i].y, i ? ends[i-1].y + gap : top);

  graphG.append("g").selectAll("text").data(ends).join("text")
    .attr("class","series-name").attr("x", w - PAD.right + 10).attr("y", d => d.y)
    .attr("dy",".32em").attr("fill","var(--accent)").text(d => d.n);

  cursor = graphG.append("line").attr("class","cursor")
    .attr("y1",PAD.top).attr("y2",h - PAD.bottom);

  graphG.append("text").attr("class","caveat").attr("x",PAD.left).attr("y",h-8)
    .text("*Sample data. Not a real figure anywhere on this chart.");

  const back = graphG.append("g").attr("class","back")
    .attr("transform",`translate(${w-84},6)`).on("click", () => setView(lastMap));
  back.append("rect").attr("width",78).attr("height",22).attr("rx",11);
  back.append("text").attr("x",39).attr("y",15).text("\u2190 Map");
}

/* ---- views -------------------------------------------------------------- */
function setView(v){
  view = v;
  const g = v.startsWith("graph");
  if (!g){ mode = v; lastMap = v; }
  document.querySelectorAll("button.view")
    .forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
  [sea, landG, labelG].forEach(l => l.style("display", g ? "none" : null));
  graphG.style("display", g ? null : "none");
  const lg = document.querySelector(".legend");
  if (lg) lg.style.visibility = g ? "hidden" : "";
  if (ready){ if (g) buildGraph(v === "graph-all"); update(); }
}
document.querySelectorAll("button.view")
  .forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));

/* ---- year strip --------------------------------------------------------- */
function buildYears(){
  d3.select("#timeline").selectAll("button").data(years, d => d).join(
    enter => enter.append("button").attr("class","year").text(d => d)
      .on("click", (e,d) => { stop(); step = years.indexOf(d) * STEPS_PER_YEAR; update(); }),
    upd => upd, exit => exit.remove());
}

/* ---- transport ---------------------------------------------------------- */
const go = s => { step = Math.max(0, Math.min(STEPS-1, s)); update(); };
$("#prev").addEventListener("click", () => { stop(); go(step-1); });
$("#next").addEventListener("click", () => { stop(); go(step+1); });
$("#loop").addEventListener("click", e => {
  looping = !looping; e.currentTarget.setAttribute("aria-pressed", String(looping));
});
$("#speed").addEventListener("click", e => {
  speed = speed === 4 ? 1 : speed * 2;
  e.currentTarget.innerHTML = speed + "&times;";
  if (timer){ stop(); start(); }
});
$("#play").addEventListener("click", () => timer ? stop() : start());

function start(){
  if (step >= STEPS-1) go(0);
  $("#play").innerHTML = "&#10074;&#10074;";
  $("#play").setAttribute("aria-label","Pause");
  timer = setInterval(() => {
    if (step >= STEPS-1) return looping ? go(0) : stop();
    go(step+1);
  }, STEP_MS / speed);
}
function stop(){
  clearInterval(timer); timer = null;
  $("#play").innerHTML = "&#9654;";
  $("#play").setAttribute("aria-label","Play");
}

/* ---- tabs (only wired up if the markup above is uncommented) ------------- */
document.querySelectorAll("button.tab").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("button.tab")
    .forEach(x => x.setAttribute("aria-selected", String(x === b)));
  loadSet(b.dataset.set);
  if (view.startsWith("graph")) buildGraph(view === "graph-all");
  update();
}));

loadSet(setName);
