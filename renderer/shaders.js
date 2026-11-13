// Scene shaders. Each scene defines: vec3 scene(vec2 uv, vec2 p)
//   uv: 0..1 across the reference area (all monitors in Span mode, this monitor otherwise)
//   p : aspect-correct coords, y in -0.5..0.5, x in -aspect/2..aspect/2
window.PALETTES = {
  aurora:   { name: 'Aurora',   c: ['#040816', '#0b3a52', '#22c08a', '#b58cff'] },
  ocean:    { name: 'Ocean',    c: ['#020a18', '#0a3a6e', '#1fa8c9', '#d8f6ff'] },
  sunset:   { name: 'Sunset',   c: ['#12061f', '#6a1b5e', '#f2643d', '#ffd38a'] },
  forest:   { name: 'Forest',   c: ['#04100b', '#14452f', '#6fae4a', '#f1e9b8'] },
  ember:    { name: 'Ember',    c: ['#0a0403', '#5a1208', '#e8601c', '#ffd27a'] },
  lavender: { name: 'Lavender', c: ['#0d0820', '#3d2a78', '#b07ae0', '#ffd9f2'] },
  rose:     { name: 'Rosé',     c: ['#14080e', '#6b2440', '#e58aa0', '#ffe9dc'] },
  mono:     { name: 'Moonlight', c: ['#05070a', '#27323f', '#8496a8', '#f2f6fa'] },
};

window.SCENES = [
  { id: 'aurora',  name: 'Aurora' },
  { id: 'nebula',  name: 'Nebula' },
  { id: 'silk',    name: 'Silk' },
  { id: 'water',   name: 'Deep Water' },
  { id: 'stars',   name: 'Starfield' },
  { id: 'lava',    name: 'Lava Lamp' },
  { id: 'ridges',  name: 'Ridgelines' },
  { id: 'ripples', name: 'Ripples' },
  { id: 'mandala', name: 'Mandala' },
  { id: 'bokeh',   name: 'Bokeh' },
  { id: 'lines',   name: 'Horizon Lines' },
  { id: 'sierpinski', name: 'Sierpiński Zoom', group: 'algo' },
  { id: 'sorting',    name: 'Sorting',         group: 'algo' },
  { id: 'life',       name: 'Game of Life',    group: 'algo' },
  { id: 'maze',       name: 'Maze Solver',     group: 'algo' },
  { id: 'julia',      name: 'Julia Set',       group: 'algo' },
  { id: 'hilbert',    name: 'Hilbert Curve',   group: 'algo' },
  { id: 'voronoi',    name: 'Voronoi',         group: 'algo' },
];

window.SHADER_VERT = `attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }`;

window.SHADER_HEAD = `
precision highp float;
uniform vec2 uRes;
uniform vec4 uView;
uniform float uAspect;
uniform float uTime;
uniform vec3 uAudio;
uniform float uBright;
uniform vec3 uC0, uC1, uC2, uC3;
uniform sampler2D uData;   // simulation state for Sorting / Life / Maze
uniform vec2 uDataSize;
uniform sampler2D uSpec;   // row 0: 64-band spectrum (low -> high), row 1: waveform
uniform float uReact;      // sound reactivity
uniform float uBeat;       // 1 on a beat, decays to 0
uniform vec4 uBeatAge;     // seconds since each of the last four beats
uniform float uATime;      // a clock that runs faster when the music is loud
uniform float uOverlay;    // 0 none, 1 spectrum bars, 2 waveform

float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x), mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5; mat2 m = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++){ v += a * noise(p); p = m * p * 2.03 + 11.7; a *= 0.5; }
  return v;
}
float spec(float x){ return texture2D(uSpec, vec2(clamp(x, 0.0, 1.0) * (63.0 / 64.0) + 0.5 / 64.0, 0.25)).r * uReact; }
float wave(float x){ return (texture2D(uSpec, vec2(clamp(x, 0.0, 1.0) * (63.0 / 64.0) + 0.5 / 64.0, 0.75)).r - 0.5) * 2.0; }
float beatRings(vec2 p, vec2 c, float speed){      // a soft ring expands from c on every beat
  float r = length(p - c), s = 0.0;
  for (int i = 0; i < 4; i++){
    float a = uBeatAge[i];
    s += exp(-pow((r - a * speed) * 14.0, 2.0)) * exp(-a * 1.3) * step(a, 5.0);
  }
  return s * uReact;
}
float sdSeg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0); return length(pa - ba * h); }
vec3 pal(float t){
  t = clamp(t, 0.0, 1.0) * 3.0;
  vec3 c = mix(uC0, uC1, smoothstep(0.0, 1.0, t));
  c = mix(c, uC2, smoothstep(1.0, 2.0, t));
  return mix(c, uC3, smoothstep(2.0, 3.0, t));
}
float stars(vec2 p, float scale){
  vec2 g = p * scale, id = floor(g), f = fract(g) - 0.5;
  float h = hash21(id);
  vec2 o = vec2(hash21(id + 7.13), hash21(id + 3.71)) - 0.5;
  float d = length(f - o * 0.7);
  float tw = 0.55 + 0.45 * sin(uTime * (0.4 + h * 1.6) + h * 40.0);
  return smoothstep(0.085, 0.0, d) * step(0.7, h) * tw;
}
`;

window.SHADER_TAIL = `
void main(){
  vec2 uv = uView.xy + (gl_FragCoord.xy / uRes) * uView.zw;
  vec2 p = (uv - 0.5) * vec2(uAspect, 1.0);
  vec3 col = scene(uv, p);
  col *= uBright * (1.0 + 0.22 * uAudio.x + 0.12 * uBeat * uReact);
  if (uOverlay > 0.5 && uOverlay < 1.5){            // spectrum bars along the bottom
    float n = 64.0, bx = uv.x * n, bi = floor(bx), fx = fract(bx);
    float v = texture2D(uSpec, vec2((bi + 0.5) / 64.0, 0.25)).r;
    float h = 0.012 + v * 0.3, y = uv.y - 0.03;
    float bar = step(0.14, fx) * step(fx, 0.86) * step(0.0, y) * step(y, h);
    vec3 bc = pal(0.45 + 0.5 * (y / 0.32)) * (1.0 + v);
    col = mix(col, bc, bar * 0.85);
    col += pal(0.9) * step(0.14, fx) * step(fx, 0.86) * exp(-abs(y - h) * 90.0) * 0.5 * v;
    float ry = -y; col = mix(col, bc * 0.3, step(0.14, fx) * step(fx, 0.86) * step(0.0, ry) * step(ry, h * 0.4) * (1.0 - ry / max(h * 0.4, 1e-3)) * 0.6);
  } else if (uOverlay > 1.5){                       // waveform line across the middle
    float w = wave(uv.x) * 0.16, d = abs(uv.y - 0.5 - w);
    col += pal(0.92) * (smoothstep(0.004, 0.0, d) + 0.35 * exp(-d * 60.0));
  }
  col = col / (1.0 + 0.18 * col);                         // gentle roll-off, no harsh clipping
  col += (hash21(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0; // dither: no banding in dark gradients
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}`;

window.SCENE_SRC = {

aurora: `
vec3 scene(vec2 uv, vec2 p){
  float t = uTime * 0.07;
  vec3 col = mix(uC0 * 0.8 + uC1 * 0.1, uC0 * 1.1 + uC1 * 0.14, uv.y);
  col += vec3(0.9, 0.95, 1.0) * (stars(p, 34.0) + 0.6 * stars(p + 3.3, 61.0)) * 0.8;
  for (int i = 0; i < 3; i++){
    float fi = float(i);
    float x = p.x * (0.75 + fi * 0.22) + fi * 3.7;
    float w = fbm(vec2(x * 0.7 + t * (1.0 + fi * 0.3), t * 0.6 + fi * 2.0));
    float eq = spec(uv.x * 0.85 + 0.05 + fi * 0.04);
    float base = -0.36 + fi * 0.11 + (w - 0.5) * 0.42 - 0.09 * eq;
    float d = p.y - base;
    float ray = noise(vec2(x * 13.0 + w * 6.0, t * 1.6 + fi * 5.0));
    float curtain = smoothstep(-0.04, 0.11, d) * exp(-max(d, 0.0) * (2.4 + ray * 3.4));
    curtain *= 0.3 + 0.7 * ray;
    col += pal(0.42 + 0.14 * fi + d * 0.55) * curtain * (0.75 + 0.6 * uAudio.y + 1.2 * eq);
  }
  col += pal(0.85) * beatRings(p, vec2(0.0, -0.6), 0.5) * 0.25;
  float hz = smoothstep(-0.52, -0.4, p.y);
  return col * (0.55 + 0.45 * hz);
}`,

nebula: `
vec3 scene(vec2 uv, vec2 p){
  vec2 q = p * 0.85; float t = uTime * 0.025;
  vec2 w = vec2(fbm(q + vec2(t, -t)), fbm(q + vec2(5.2, 1.3) - t));
  vec2 r = vec2(fbm(q + 2.0 * w + vec2(1.7, 9.2) + t * 0.7), fbm(q + 2.0 * w + vec2(8.3, 2.8) - t * 0.5));
  float f = fbm(q + 2.4 * r);
  vec3 col = pal(f * f * 1.7 + 0.2 * length(r) - 0.06);
  col *= 0.1 + 1.9 * f * f * (1.0 + 0.6 * uAudio.x) + 0.6 * spec(f * 0.8) * f;
  float s = stars(p, 30.0) + 0.7 * stars(p + 5.1, 55.0);
  col += vec3(1.0, 0.97, 0.92) * s * (1.0 - 0.75 * f) * (1.0 + 2.5 * uAudio.z);
  col += pal(0.9) * beatRings(p, vec2(0.0), 0.45) * 0.3 * (0.4 + f);
  return col;
}`,

silk: `
vec3 scene(vec2 uv, vec2 p){
  vec2 q = p * 1.35; float t = uTime * 0.12;
  for (int i = 1; i < 6; i++){
    float fi = float(i);
    float amp = 0.34 * (1.0 + 0.7 * uAudio.x);
    q.x += amp / fi * sin(fi * 1.7 * q.y + t + fi * 1.3);
    q.y += amp / fi * cos(fi * 1.5 * q.x + t * 0.8 + fi * 2.1);
  }
  float v = 0.5 + 0.5 * sin(q.x * 1.8 + q.y * 2.1);
  float sheen = pow(0.5 + 0.5 * sin((q.x - q.y) * 5.0 + v * 3.0), 6.0);
  vec3 col = pal(0.08 + v * 0.62);
  col += pal(0.95) * sheen * (0.16 + 0.6 * uAudio.z + 0.8 * spec(v));
  return col * (0.75 + 0.25 * v);
}`,

water: `
float web(vec2 q, float t){
  float v = 0.0, a = 1.0; mat2 m = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 4; i++){
    q = m * q * 1.35 + vec2(sin(t + q.y * 1.3), cos(t * 0.9 + q.x * 1.1)) * 0.42;
    v += a * pow(1.0 - abs(sin(q.x) * sin(q.y)), 9.0);
    a *= 0.62;
  }
  return v;
}
vec3 scene(vec2 uv, vec2 p){
  float t = uTime * 0.22;
  float c = web(p * 3.2 + vec2(0.0, t * 0.15), t);
  float depth = smoothstep(-0.6, 0.6, p.y);
  vec3 col = pal(0.06 + 0.42 * depth);
  float rays = fbm(vec2(p.x * 2.6 + p.y * 0.9, t * 0.35)) * fbm(vec2(p.x * 5.0 + p.y * 1.6 + 4.0, -t * 0.25));
  col += pal(0.8) * rays * depth * 0.9;
  col += pal(0.92) * c * (0.10 + 0.22 * depth) * (1.0 + 1.6 * uAudio.y + 1.2 * spec(uv.x));
  col += pal(0.9) * beatRings(p, vec2(0.0, 0.7), 0.5) * 0.3;
  return col;
}`,

stars: `
vec3 scene(vec2 uv, vec2 p){
  float t = uTime;
  float band = fbm(p * 0.9 + vec2(t * 0.004, 0.0));
  float band2 = fbm(p * 2.3 - vec2(0.0, t * 0.003) + band);
  vec3 col = pal(0.08 + 0.75 * band * band2) * (0.4 + 1.1 * band2);
  vec3 tint = mix(uC3, vec3(1.0), 0.55);
  for (int i = 0; i < 5; i++){
    float fi = float(i);
    float tt = t + uATime * 6.0;
    vec2 q = p + vec2(tt * 0.004 * (1.0 + fi), tt * 0.0015 * fi) + fi * 11.3;
    col += tint * stars(q, 14.0 + fi * 11.0) * (2.0 - fi * 0.3) * (1.0 + 2.2 * uAudio.z + 1.5 * spec(0.55 + fi * 0.09));
  }
  col *= 1.0 + 0.6 * uAudio.x * band2;
  return col;
}`,

lava: `
vec3 scene(vec2 uv, vec2 p){
  float t = uTime * 0.35, f = 0.0;
  for (int i = 0; i < 14; i++){
    float fi = float(i);
    vec2 c = vec2(sin(t * (0.21 + 0.031 * fi) + fi * 2.4) * uAspect * 0.46,
                  sin(t * (0.17 + 0.043 * fi) + fi * 1.3) * 0.44);
    float r = 0.19 + 0.07 * sin(fi * 3.1) + 0.05 * uAudio.x + 0.04 * spec(fi / 14.0);
    f += r * r / (dot(p - c, p - c) + 0.0006);
  }
  float m = smoothstep(0.92, 1.12, f);
  vec3 bg = pal(0.05 + 0.2 * uv.y) + pal(0.5) * min(f, 1.0) * 0.16;
  vec3 blob = pal(0.44 + 0.5 * clamp((f - 1.0) * 0.1, 0.0, 1.0));
  vec3 col = mix(bg, blob * (1.0 + 0.5 * uAudio.y), m);
  return col + pal(0.85) * beatRings(p, vec2(0.0), 0.5) * 0.25;
}`,

ridges: `
float ridge(float x){ return noise(vec2(x, 3.7)) * 0.6 + noise(vec2(x * 2.3, 9.1)) * 0.28 + noise(vec2(x * 5.9, 1.3)) * 0.12; }
vec3 scene(vec2 uv, vec2 p){
  float t = uTime * 0.012;
  vec3 sky = pal(0.34 + 0.52 * smoothstep(-0.25, 0.55, -p.y + 0.3));
  sky = mix(sky, pal(0.2), smoothstep(0.1, 0.6, p.y));
  vec2 sp = p - vec2(0.0, 0.1);
  float sd = length(sp);
  float sr = 0.072 * (1.0 + 0.3 * uAudio.x + 0.25 * uBeat * uReact);
  vec3 col = sky + pal(0.97) * (smoothstep(sr + 0.004, sr, sd) * 0.9 + 0.22 * exp(-sd * 5.0) * (1.0 + 1.6 * uAudio.x));
  col += vec3(1.0) * stars(p, 40.0) * smoothstep(0.1, 0.45, p.y) * 0.6;
  for (int i = 0; i < 6; i++){
    float fi = float(i), depth = fi / 5.0;
    float h = 0.06 - depth * 0.44 + 0.10 * spec(uv.x) * (1.0 - depth) * step(fi, 1.5) + (ridge(p.x * (1.1 + fi * 0.45) + fi * 13.0 + t * (1.0 + fi * 1.4)) - 0.5) * (0.34 - depth * 0.14);
    float m = smoothstep(h + 0.002, h - 0.002, p.y);
    vec3 lc = mix(mix(sky, pal(0.3), 0.45), uC0 * 0.55, depth);
    float mist = exp(-(h - p.y) * 9.0) * (1.0 - depth) * 0.35;
    col = mix(col, lc + sky * mist, m);
  }
  return col;
}`,

ripples: `
vec3 scene(vec2 uv, vec2 p){
  float t = uTime * 0.5, v = 0.0;
  for (int i = 0; i < 6; i++){
    float fi = float(i);
    vec2 c = vec2(sin(t * (0.05 + 0.013 * fi) + fi * 4.0) * uAspect * 0.42, cos(t * (0.06 + 0.017 * fi) + fi * 2.0) * 0.38);
    float d = length(p - c);
    v += sin(d * 26.0 - uTime * 0.9 + fi * 1.7) * exp(-d * 1.5);
  }
  v *= 0.3 + 0.35 * uAudio.x;
  float n = fbm(p * 1.4 + uTime * 0.01);
  vec3 col = pal(0.26 + 0.24 * n + v * 0.5);
  col += pal(0.96) * pow(max(v, 0.0), 3.0) * 1.3;
  col += pal(0.95) * beatRings(p, vec2(0.0), 0.55) * 0.7;
  return col * 0.9;
}`,

mandala: `
vec3 scene(vec2 uv, vec2 p){
  float r = length(p), a = atan(p.y, p.x), n = 8.0;
  a = abs(mod(a + uTime * 0.01, 6.28318 / n) - 3.14159 / n);
  vec2 q = vec2(cos(a), sin(a)) * r;
  float f = fbm(q * 3.0 + vec2(-uTime * 0.045, uTime * 0.02));
  float g = fbm(q * 6.0 - f * 2.2 + uTime * 0.015);
  float rings = 0.5 + 0.5 * sin(r * 13.0 - uTime * 0.25 - uATime * 2.0 + f * 6.0);
  rings *= 0.7 + 1.8 * spec(r * 0.45);
  vec3 col = pal(0.1 + 0.75 * g * (0.55 + 0.45 * rings) + 0.15 * f);
  col *= 0.3 + 1.0 * g + 0.25 * rings * (1.0 + uAudio.y);
  col += pal(0.95) * beatRings(p, vec2(0.0), 0.5) * 0.45;
  return col * (1.0 - 0.25 * smoothstep(0.3, 2.8, r));
}`,

bokeh: `
vec3 scene(vec2 uv, vec2 p){
  float t = uTime;
  vec3 col = pal(0.08 + 0.2 * uv.y + 0.14 * fbm(p * 0.8 + t * 0.01));
  for (int i = 0; i < 4; i++){
    float fi = float(i), s = 2.2 + fi * 1.3;
    vec2 g = (p + vec2(t * 0.006 * (fi + 1.0), t * 0.009 + fi * 0.37)) * s + fi * 17.0;
    vec2 id = floor(g), f = fract(g) - 0.5;
    float h = hash21(id + fi * 7.7), h2 = hash21(id + 31.7), h3 = hash21(id + 77.1);
    vec2 o = 0.14 * vec2(sin(t * 0.18 * (0.5 + h) + h * 30.0), cos(t * 0.15 * (0.5 + h2) + h * 50.0));
    float rad = 0.10 + 0.2 * h2;
    float d = length(f - o);
    float disc = smoothstep(rad, rad * 0.78, d) * (0.85 + 0.15 * smoothstep(rad * 0.6, rad, d));
    float glow = (0.05 + 0.22 * h3) * (0.6 + 0.4 * sin(t * 0.25 + h * 20.0)) * step(0.3, h) * (1.0 + 0.7 * uAudio.x + 2.4 * spec(h));
    col += pal(0.38 + 0.6 * h) * disc * glow;
  }
  return col;
}`,

lines: `
vec3 scene(vec2 uv, vec2 p){
  vec3 col = pal(0.04 + 0.16 * uv.y) * 0.8;
  for (int i = 0; i < 11; i++){
    float fi = float(i);
    float amp = 1.0 + 1.0 * uAudio.x + 3.0 * spec(fi / 11.0 + 0.03);
    float y = -0.44 + fi * 0.085
      + 0.05 * sin(p.x * 1.4 + uTime * 0.16 + fi * 0.7) * amp
      + 0.09 * (noise(vec2(p.x * 1.1 + fi * 5.0, uTime * 0.06 + fi)) - 0.5) * amp;
    float d = p.y - y;
    vec3 c = pal(0.3 + 0.065 * fi);
    col += c * (0.0022 / (abs(d) + 0.0022)) * (0.55 + 0.8 * spec(fi / 11.0 + 0.03));
    col += c * smoothstep(0.0, -0.3, d) * step(d, 0.0) * 0.035;
  }
  return col;
}`,

sierpinski: `
// Infinite zoom: every 8x the view lands on an identical copy of itself (fixed point of corner maps A, B, C).
vec3 scene(vec2 uv, vec2 p){
  vec2 A = vec2(0.0, 0.57735), B = vec2(-0.5, -0.288675), C = vec2(0.5, -0.288675);
  vec2 P = (C + 2.0 * B + 4.0 * A) / 7.0;
  float ph = fract(uTime * 0.03);
  float sc = 0.21 / sqrt(uAspect * uAspect + 1.0) * pow(8.0, -ph) / (1.0 + 0.05 * uAudio.x);
  vec2 w = P + p * sc;
  vec2 v0 = B - A, v1 = C - A, v2 = w - A;
  float d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
  float den = d00 * d11 - d01 * d01;
  float b = (d11 * d20 - d01 * d21) / den, c = (d00 * d21 - d01 * d20) / den, a = 1.0 - b - c;
  vec3 bg = pal(0.04);
  if (min(a, min(b, c)) < 0.0) return bg;
  float level = -1.0, edge = 0.0;
  for (int i = 0; i < 22; i++){
    if (a >= 0.5){ a = 2.0 * a - 1.0; b *= 2.0; c *= 2.0; }
    else if (b >= 0.5){ b = 2.0 * b - 1.0; a *= 2.0; c *= 2.0; }
    else if (c >= 0.5){ c = 2.0 * c - 1.0; a *= 2.0; b *= 2.0; }
    else { level = float(i); edge = 0.5 - max(a, max(b, c)); break; }
  }
  if (level < 0.0) return pal(0.95);
  float k = level - 3.0 * ph;                 // colour follows depth so the loop is seamless
  float band = spec(fract(k / 8.0 + 0.0625));
  vec3 fillc = pal(0.2 + 0.6 * (0.5 + 0.5 * sin(k * 0.75))) * (0.14 + 0.2 * (0.5 + 0.5 * cos(k * 1.3)) + 0.6 * band);
  float es = edge * 0.866 / (pow(2.0, level) * sc);     // distance to the hole's edge, in screen units
  float line = (smoothstep(0.0022, 0.0, es) + 0.35 * exp(-es * 140.0)) * (0.75 + 1.0 * uAudio.x);
  vec3 col = fillc * (0.75 + 0.25 * smoothstep(0.0, 0.08, es)) + pal(0.92) * line;
  return col + pal(0.95) * beatRings(p, vec2(0.0), 0.5) * 0.35;
}`,

sorting: `
vec3 scene(vec2 uv, vec2 p){
  float n = uDataSize.x, x = uv.x * n, i = floor(x), fx = fract(x);
  vec4 d = texture2D(uData, vec2((i + 0.5) / n, 0.5));
  vec3 bg = pal(0.03 + 0.07 * uv.y);
  float gap = n > 140.0 ? 0.14 : 0.2;
  float inBar = step(gap * 0.5, fx) * step(fx, 1.0 - gap * 0.5);
  float base = 0.12, y = uv.y - base;
  float h = (0.05 + 0.76 * d.r) * (1.0 + 0.10 * uAudio.x);
  vec3 c = pal(0.28 + 0.68 * d.r) * (1.0 + 1.1 * spec(d.r));
  c = mix(c, pal(0.98) * 1.35, d.g * 0.85);          // the bars being compared / swapped
  c = mix(c, pal(0.85) * 1.2, d.b * 0.7);            // the "is it sorted?" sweep
  vec3 col = bg;
  if (y >= 0.0 && y < h) col = mix(bg, c * (0.6 + 0.4 * y / h), inBar);
  float ry = -y, rh = h * 0.3;
  if (ry > 0.0 && ry < rh) col = mix(bg, c * 0.22 * (1.0 - ry / rh), inBar);
  col += pal(0.98) * d.g * inBar * exp(-abs(y - h) * 40.0) * 0.6;
  return col;
}`,

life: `
vec3 scene(vec2 uv, vec2 p){
  vec2 n = uDataSize, g = uv * n, cell = floor(g), f = fract(g) - 0.5;
  vec4 d = texture2D(uData, (cell + 0.5) / n);
  vec4 soft = texture2D(uData, uv);
  vec3 col = pal(0.03 + 0.06 * uv.y);
  float sq = smoothstep(0.5, 0.34, max(abs(f.x), abs(f.y)));
  col += pal(0.25 + 0.3 * d.g) * d.g * 0.3 * sq;
  col += pal(0.62 + 0.36 * d.b) * d.r * sq * (0.85 + 1.0 * uAudio.x + 0.8 * spec(uv.x));
  col += pal(0.8) * soft.r * 0.3 * (1.0 + 1.6 * uAudio.y);
  return col;
}`,

maze: `
vec3 scene(vec2 uv, vec2 p){
  vec2 n = uDataSize, cell = floor(uv * n);
  vec4 d = texture2D(uData, (cell + 0.5) / n);
  vec4 s = texture2D(uData, uv);
  vec3 col = pal(0.02 + 0.04 * uv.y);
  vec3 c = pal(0.2 + 0.3 * d.r) * (0.25 + 0.6 * d.r);
  if (d.g > 0.0) c = pal(0.3 + 0.6 * d.g) * (0.75 + 1.4 * spec(d.g));
  col = mix(col, c, step(0.01, d.r));
  col = mix(col, pal(0.98) * (1.3 + 0.8 * uAudio.y), d.b);
  col += pal(0.95) * (d.a * 1.3 + s.a * 0.8) * (1.0 + uAudio.x);
  col += pal(0.95) * s.b * 0.3;
  return col;
}`,

julia: `
vec3 scene(vec2 uv, vec2 p){
  float tiles = max(1.0, floor(uAspect / 1.78 + 0.5)), tw = uAspect / tiles;
  float tx = (p.x + uAspect * 0.5) / tw, ti = floor(tx);
  vec2 lp = vec2((fract(tx) - 0.5) * tw, p.y);
  float a = uTime * 0.035 + ti * 0.55;
  vec2 e1 = vec2(cos(a), sin(a)), e2 = vec2(cos(2.0 * a), sin(2.0 * a));
  vec2 c = (e1 * 0.5 - e2 * 0.25) * (0.985 - 0.01 * uAudio.x);     // just inside the main cardioid: connected, ornate sets
  vec2 z = lp * 2.4;
  float it = 0.0, trap = 10.0;
  for (int i = 0; i < 120; i++){
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    trap = min(trap, abs(length(z) - 0.6));
    if (dot(z, z) > 256.0) break;
    it += 1.0;
  }
  if (it > 119.0) return pal(0.38 + 0.5 * (0.5 + 0.5 * cos(trap * 18.0 - uTime * 0.4))) * (0.5 + 0.25 * exp(-trap * 4.0) + 0.7 * uAudio.y);   // inside: contour bands
  float sm = (it - log2(log2(dot(z, z))) + 4.0) / 120.0;
  float t = pow(clamp(sm, 0.0, 1.0), 0.5);
  vec3 col = pal(0.04 + 0.92 * t) * (0.12 + 1.6 * t * t) * (1.0 + 1.3 * spec(t));
  col += pal(0.95) * exp(-trap * 14.0) * 0.25;
  return col + pal(0.9) * beatRings(p, vec2(0.0), 0.5) * 0.3;
}`,

hilbert: `
vec2 hrot(float s, vec2 q, float rx, float ry){
  if (ry < 0.5){ if (rx > 0.5) q = s - 1.0 - q; q = q.yx; }
  return q;
}
vec2 d2xy(float n, float d){
  vec2 q = vec2(0.0); float t = d, s = 1.0;
  for (int k = 0; k < 8; k++){
    if (s >= n) break;
    float rx = mod(floor(t / 2.0), 2.0);
    float ry = mod(t + rx, 2.0);
    q = hrot(s, q, rx, ry);
    q += s * vec2(rx, ry);
    t = floor(t / 4.0); s *= 2.0;
  }
  return q;
}
float xy2d(float n, vec2 q){
  float d = 0.0, s = n / 2.0;
  for (int k = 0; k < 8; k++){
    if (s < 1.0) break;
    float rx = mod(floor(q.x / s), 2.0), ry = mod(floor(q.y / s), 2.0);
    d += s * s * mix(ry, 3.0 - ry, rx);
    q = mod(q, s);
    q = hrot(s, q, rx, ry);
    s /= 2.0;
  }
  return d;
}
vec3 scene(vec2 uv, vec2 p){
  float tiles = max(1.0, floor(uAspect + 0.25)), tw = uAspect / tiles;
  float side = min(1.0, tw) * 0.9;
  float tx = (p.x + uAspect * 0.5) / tw, ti = floor(tx);
  vec2 lp = vec2((fract(tx) - 0.5) * tw, p.y) / side + 0.5;
  vec3 col = pal(0.03 + 0.06 * uv.y);
  if (lp.x < 0.0 || lp.x >= 1.0 || lp.y < 0.0 || lp.y >= 1.0) return col;
  float N = 64.0, total = N * N;
  vec2 cell = floor(lp * N), f = fract(lp * N) - 0.5;
  float d = xy2d(N, cell);
  float ph = fract(uTime * 0.02 + ti * 0.29);
  float head = min(ph / 0.8, 1.0) * total;
  float fade = 1.0 - smoothstep(0.9, 1.0, ph);
  float lw = 0.12 + 0.12 * uAudio.x, dist = 10.0;
  if (d >= 1.0){
    vec2 dp = d2xy(N, d - 1.0) - cell;
    float k = clamp((head - d + 0.5) * 2.0, 0.0, 1.0);
    if (k > 0.0) dist = min(dist, sdSeg(f, dp * 0.5, dp * 0.5 * (1.0 - k)));
  }
  if (d < total - 1.0){
    vec2 dn = d2xy(N, d + 1.0) - cell;
    float k2 = clamp((head - d) * 2.0, 0.0, 1.0);
    if (k2 > 0.0) dist = min(dist, sdSeg(f, vec2(0.0), dn * 0.5 * k2));
  }
  float age = clamp((head - d) / total, 0.0, 1.0);
  vec3 lc = pal(0.95 - 0.62 * age) * (1.0 + 1.3 * spec(1.0 - age));
  col += lc * smoothstep(lw, lw - 0.06, dist) * fade;
  col += lc * exp(-dist * 7.0) * 0.18 * fade;
  col += pal(0.98) * exp(-abs(head - d) * 0.08) * exp(-length(f) * 3.0) * (1.0 - step(total, head)) * 1.2;
  return col;
}`,

voronoi: `
vec3 scene(vec2 uv, vec2 p){
  vec2 g = p * 5.5, id = floor(g), f = fract(g);
  float d1 = 8.0, d2 = 8.0; vec2 best = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    vec2 o = vec2(float(i), float(j));
    vec2 h = vec2(hash21(id + o), hash21(id + o + 19.1));
    vec2 pt = o + 0.5 + 0.42 * sin(uTime * 0.22 + 6.2831 * h + uATime * 0.6);
    float d = length(pt - f);
    if (d < d1){ d2 = d1; d1 = d; best = id + o; } else if (d < d2) d2 = d;
  }
  float hh = hash21(best), border = d2 - d1;
  vec3 col = pal(0.12 + 0.55 * hh) * (0.35 + 0.5 * (1.0 - d1)) * (0.6 + 2.0 * spec(hh));
  col += pal(0.93) * smoothstep(0.07, 0.0, border) * (0.45 + 1.2 * uAudio.x);
  col += pal(0.98) * smoothstep(0.06, 0.0, d1) * (0.7 + uAudio.z);
  return col + pal(0.9) * beatRings(p, vec2(0.0), 0.5) * 0.3;
}`,
};
