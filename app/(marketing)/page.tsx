import { Navbar } from '@/components/marketing/Navbar';
import { Hero } from '@/components/marketing/Hero';
import { Story } from '@/components/marketing/Story';
import { HowItWorks } from '@/components/marketing/HowItWorks';

export default function Landing() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <Story />
        <HowItWorks />
        {/* Front page 3: privacy, compatibility, CTA, footer */}
      </main>
    </>
  );
}