import { onCleanup, onMount } from 'solid-js';
import { getAnalyser } from './audioOutput';
import { onFlash } from './flash';
import { palettes, type Visual } from '../shared/visuals';

type RGB = [number, number, number];

const hexToRgb = (hex: string): RGB => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** Color at t (0..1) along a palette. */
function colorAt(stops: RGB[], t: number, alpha = 1): string {
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

/** Splits FFT bins into bands spaced like hearing (more detail in the bass). */
function bands(freq: Uint8Array, count: number): number[] {
  const top = Math.min(freq.length, 140); // up to ~13 kHz
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = Math.floor(Math.pow(top, i / count));
    const b = Math.max(a + 1, Math.floor(Math.pow(top, (i + 1) / count)));
    let sum = 0;
    for (let j = a; j < b; j++) sum += freq[j];
    out.push(sum / (b - a) / 255);
  }
  return out;
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Full-screen visuals behind the phone page, drawn from the music the phone
 * is playing, so they're in time with what each listener hears. The DJ picks
 * the style and colors; flashes come from the DJ too.
 */
export function Visualizer(props: { visual: Visual; playing: boolean }) {
  let canvas!: HTMLCanvasElement;

  onMount(() => {
    const g = canvas.getContext('2d')!;
    let freq = new Uint8Array(256);
    let wave = new Uint8Array(512);
    let bassAvg = 0;
    let flash: { color: string; at: number } | null = null;
    let lastFlash = 0;
    let raf = 0;

    const stopFlash = onFlash((color) => {
      const now = performance.now();
      if (now - lastFlash < 300) return; // never strobe faster than this
      lastFlash = now;
      flash = { color, at: now };
    });

    // Size from the canvas itself (it covers the viewport): on phones
    // innerHeight and 100vh disagree while the address bar moves, which
    // pushed the drawing off center.
    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const stops = palettes[props.visual.palette].colors.map(hexToRgb);
      g.clearRect(0, 0, w, h);

      const analyser = props.playing ? getAnalyser() : null;
      if (analyser) {
        if (freq.length !== analyser.frequencyBinCount) freq = new Uint8Array(analyser.frequencyBinCount);
        if (wave.length !== analyser.fftSize) wave = new Uint8Array(analyser.fftSize);
        analyser.getByteFrequencyData(freq);
        analyser.getByteTimeDomainData(wave);
      } else {
        freq.fill(0);
        wave.fill(128);
      }
      const bass = (freq[1] + freq[2] + freq[3] + freq[4]) / (4 * 255);
      bassAvg += (bass - bassAvg) * 0.05;
      const kick = Math.max(0, bass - bassAvg) * 3; // jumps on beats

      const focus = centerTarget(w, h);
      if (props.visual.style !== 'off') {
        // A glow that breathes with the bass.
        const glow = g.createRadialGradient(focus.x, focus.y, 0, focus.x, focus.y, Math.max(w, h) * 0.8);
        glow.addColorStop(0, colorAt(stops, 0, 0.12 + bass * 0.3 + kick * 0.2));
        glow.addColorStop(1, colorAt(stops, 0, 0));
        g.fillStyle = glow;
        g.fillRect(0, 0, w, h);
        g.globalCompositeOperation = 'lighter';
        if (props.visual.style === 'ring') drawRing(g, w, h, freq, stops, bass, kick, focus);
        if (props.visual.style === 'bars') drawBars(g, w, h, freq, stops);
        if (props.visual.style === 'wave') drawWave(g, w, h, wave, stops, bass, focus.y);
        g.globalCompositeOperation = 'source-over';
      }

      if (flash) {
        const t = (now - flash.at) / 450;
        if (t >= 1) flash = null;
        else {
          g.globalAlpha = (1 - t) * (reducedMotion() ? 0.3 : 0.85);
          g.fillStyle = flash.color;
          g.fillRect(0, 0, w, h);
          g.globalAlpha = 1;
        }
      }
    };
    raf = requestAnimationFrame(draw);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      stopFlash();
    });
  });

  return <canvas ref={canvas} class="visualizer" aria-hidden="true" />;
}

/**
 * What the visuals center on: the empty middle of the page while listening,
 * or the play button before. Measured without the button's pulse animation.
 */
function centerTarget(w: number, h: number): { x: number; y: number; r: number } {
  const el = document.querySelector<HTMLElement>('.stage-center, .play');
  if (!el) return { x: w / 2, y: h / 2, r: Math.min(w, h) * 0.25 };
  const b = el.getBoundingClientRect();
  const r = el.offsetWidth / 2; // layout size, unaffected by transforms
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, r };
}

function drawRing(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  freq: Uint8Array,
  stops: RGB[],
  bass: number,
  kick: number,
  around: { x: number; y: number; r: number },
) {
  const min = Math.min(w, h);
  const cx = around.x;
  const cy = around.y;
  const r = around.r + 12 + bass * min * 0.02 + kick * min * 0.03;
  const b = bands(freq, 48);
  const n = b.length * 2; // mirrored left/right
  g.lineCap = 'round';
  g.lineWidth = Math.max(2, min / 110);
  for (let i = 0; i < n; i++) {
    const v = b[i < b.length ? i : n - 1 - i];
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    const len = 4 + v * v * min * 0.18;
    g.strokeStyle = colorAt(stops, v, 0.35 + v * 0.65);
    g.beginPath();
    g.moveTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
    g.lineTo(cx + Math.cos(angle) * (r + len), cy + Math.sin(angle) * (r + len));
    g.stroke();
  }
  g.strokeStyle = colorAt(stops, 0.5, 0.25 + kick * 0.5);
  g.lineWidth = 2 + kick * 6;
  g.beginPath();
  g.arc(cx, cy, r - 6, 0, Math.PI * 2);
  g.stroke();
}

function drawBars(g: CanvasRenderingContext2D, w: number, h: number, freq: Uint8Array, stops: RGB[]) {
  const b = bands(freq, 24);
  const n = b.length * 2; // bass in the middle, treble at the edges
  const gap = w / n;
  const bw = gap * 0.62;
  for (let i = 0; i < n; i++) {
    const k = i < b.length ? b.length - 1 - i : i - b.length;
    const v = b[k];
    const bh = 6 + v * v * h * 0.42;
    const x = i * gap + (gap - bw) / 2;
    const grad = g.createLinearGradient(0, h, 0, h - bh);
    grad.addColorStop(0, colorAt(stops, k / b.length, 0.9));
    grad.addColorStop(1, colorAt(stops, k / b.length + 0.3, 0.25));
    g.fillStyle = grad;
    g.beginPath();
    g.roundRect(x, h - bh, bw, bh, bw / 2);
    g.fill();
    // Faint mirror at the top.
    g.fillStyle = colorAt(stops, k / b.length, 0.12);
    g.beginPath();
    g.roundRect(x, 0, bw, bh * 0.4, bw / 2);
    g.fill();
  }
}

function drawWave(g: CanvasRenderingContext2D, w: number, h: number, wave: Uint8Array, stops: RGB[], bass: number, mid: number) {
  const layers = 3;
  for (let l = 0; l < layers; l++) {
    const cy = mid + (l - 1) * h * 0.06;
    const amp = h * (0.22 + bass * 0.15) * (1 - l * 0.25);
    g.strokeStyle = colorAt(stops, l / (layers - 1), 0.75 - l * 0.18);
    g.lineWidth = 3 - l * 0.6;
    g.beginPath();
    const step = Math.max(1, Math.floor(wave.length / 160));
    for (let i = 0, j = l * 7; i < wave.length; i += step) {
      const x = (i / (wave.length - 1)) * w;
      const y = cy + ((wave[(i + j) % wave.length] - 128) / 128) * amp;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
}
