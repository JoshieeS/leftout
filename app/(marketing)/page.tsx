import { Navbar } from '@/components/marketing/Navbar';
import { Hero } from '@/components/marketing/Hero';

export default function Landing() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        {/* Front page 2: story + how it works */}
        {/* Front page 3: privacy, compatibility, CTA, footer */}
      </main>
    </>
  );
}