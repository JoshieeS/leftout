const oldWays = [
  {
    name: 'airdrop',
    verdict: 'apple only',
    detail: 'Works great, until someone in the group has an Android.',
  },
  {
    name: 'group chat',
    verdict: 'compressed',
    detail: 'Everyone gets a copy, but not the original quality.',
  },
  {
    name: 'shared drive',
    verdict: 'every. single. time.',
    detail: 'Make a folder, upload everything, send the link, wait for everyone to download.',
  },
];

export function Story() {
  return (
    <section className="border-t border-line">
      <div className="mx-auto max-w-6xl px-5 py-24">
        <div className="max-w-2xl space-y-5">
          <div className="text-xs text-accent">01 / the problem</div>
          <h2 className="text-3xl tracking-tight text-white md:text-4xl">We&apos;ve all been there.</h2>
          <p className="text-base leading-relaxed text-dim">
            Everyone took photos. Someone has an iPhone, someone has an Android, and by the end of the
            night the best shots are spread across five phones.
          </p>
        </div>

        <div className="mt-12 grid gap-3 md:grid-cols-3">
          {oldWays.map((w) => (
            <div key={w.name} className="rounded border border-line bg-panel p-5">
              <div className="flex items-baseline justify-between">
                <span className="text-fg">{w.name}</span>
                <span className="text-xs text-err">✕ {w.verdict}</span>
              </div>
              <p className="mt-3 text-xs leading-relaxed text-dim">{w.detail}</p>
            </div>
          ))}
        </div>

        <p className="mt-10 text-base text-fg">
          <span className="text-accent">Leftout</span> is one link. The originals. Everyone.
        </p>
      </div>
    </section>
  );
}