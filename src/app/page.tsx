import { Logo } from "./_components/logo";

export default function HomePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg p-6 text-fg">
      <Logo className="text-5xl" />
      <p className="font-display text-lg font-semibold tracking-tight">FINET</p>
    </main>
  );
}
