const steps = [
  {
    n: '01',
    title: 'Pick',
    body: 'Choose the photos and videos. Any size, full quality.',
    term: '> 47 photos · 12 videos · 2.8 GB',
  },
  {
    n: '02',
    title: 'Invite',
    body: 'Friends scan one QR code or open the link. No app, no sign-up.',
    term: '> leftout.app/d/neon-orbit-4821',
  },
  {
    n: '03',
    title: 'Transfer',
    body: 'Files go straight from your phone to theirs, encrypted on the way.',
    term: '> channel open · direct p2p',
  },
  {
    n: '04',
    title: 'Done',
    body: 'Watch each person’s progress until everyone has everything.',
    term: '> 3 / 3 received ✓',
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="scroll-mt-20 border-t border-line">
      <div className="mx-auto max-w-6xl px-5 py-24">
        <div className="max-w-2xl space-y-5">
          <div className="text-xs text-accent">02 / how it works</div>
          <h2 className="text-3xl tracking-tight text-white md:text-4xl">Four steps. No uploads.</h2>
        </div>

        <ol className="mt-12 grid gap-px overflow-hidden rounded border border-line bg-line md:grid-cols-4">
          {steps.map((s) => (
            <li key={s.n} className="flex flex-col gap-3 bg-bg p-6">
              <span className="text-xs text-dim">{s.n}</span>
              <span className="text-lg text-white">{s.title}</span>
              <p className="flex-1 text-xs leading-relaxed text-dim">{s.body}</p>
              <code className="truncate text-[11px] text-accent">{s.term}</code>
            </li>
          ))}
        </ol>

        <p className="mt-6 text-xs text-dim">
          tip: everyone on the same wi-fi, or connected to one phone&apos;s hotspot, gets the fastest transfer.
        </p>
      </div>
    </section>
  );
}