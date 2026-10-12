import { createEffect, onCleanup } from 'solid-js';

let ctx: AudioContext | null = null;

/** Live peak meter for a MediaStream. */
export function Meter(props: { stream: MediaStream | null }) {
  let bar!: HTMLDivElement;

  createEffect(() => {
    const stream = props.stream;
    bar.style.width = '0%';
    if (!stream) return;
    ctx ??= new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let raf = 0;
    const tick = () => {
      if (ctx!.state === 'suspended') ctx!.resume();
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v));
      const db = 20 * Math.log10(peak || 1e-6);
      bar.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    onCleanup(() => {
      cancelAnimationFrame(raf);
      src.disconnect();
    });
  });

  return (
    <div class="meter">
      <div ref={bar} />
    </div>
  );
}
