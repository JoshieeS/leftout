import type { Metadata } from 'next';
import { MatrixRain } from '@/components/MatrixRain';
import { Uploader } from '@/components/Uploader';

export const metadata: Metadata = { title: 'Create a drop' };

export default function AppPage() {
  return (
    <>
      <MatrixRain />
      <section className="space-y-6">
        <h1 className="text-lg">
          create a <span className="text-accent">drop</span>
        </h1>
        <p className="text-dim">
          pick the photos and videos. everyone scans one code and gets the originals.
        </p>
        <Uploader />
      </section>
    </>
  );
}