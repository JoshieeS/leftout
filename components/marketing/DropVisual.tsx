const devices = [
  { name: 'android', status: 'received', done: true },
  { name: 'iphone', status: 'receiving', done: false },
  { name: 'laptop', status: 'received', done: true },
];

export function DropVisual() {
  return (
    <div className="relative mx-auto w-full max-w-sm" aria-hidden>
      {/* the drop */}
      <div className="rounded border border-line bg-panel p-4">
        <div className="flex items-center justify-between text-xs">
          <span className="text-dim">drop</span>
          <span className="text-accent">● live</span>
        </div>
        <div className="mt-2 text-base">saturday night</div>
        <div className="mt-1 text-xs text-dim">47 photos · 12 videos · 2.8 GB</div>
      </div>

      {/* connectors */}
      <svg viewBox="0 0 300 48" className="h-12 w-full" fill="none">
        {[50, 150, 250].map((x) => (
          <path
            key={x}
            d={`M150 0 C150 24, ${x} 24, ${x} 48`}
            stroke="#00e676"
            strokeOpacity="0.5"
            strokeDasharray="4 4"
            className="animate-flow"
          />
        ))}
      </svg>

      {/* receivers */}
      <div className="grid grid-cols-3 gap-2">
        {devices.map((d) => (
          <div key={d.name} className="rounded border border-line bg-panel p-3 text-center">
            <div className="text-xs">{d.name}</div>
            <div className="mx-auto mt-2 h-1 w-full overflow-hidden rounded bg-line">
              <div className={`h-full bg-accent ${d.done ? 'w-full' : 'animate-fill'}`} />
            </div>
            <div className={`mt-2 text-[10px] ${d.done ? 'text-accent' : 'text-dim'}`}>
              {d.done ? '✓ ' : ''}
              {d.status}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}