import Link from "next/link";

const USERS = [
  { id: "alan", label: "Alan" },
  { id: "claude", label: "Claude" },
];

const PILLARS = [
  {
    label: "Witnessed",
    body: "Your partner sees your record — every check-in, every gap. The social cost of missing is real.",
  },
  {
    label: "Reflected",
    body: "When you miss, you name what was going on. Every behavior has a reason — surface it without judgment, and show up differently next time.",
  },
  {
    label: "Coached",
    body: "Weekly, you sit with your partner and go through the record together — not to blame, but to understand.",
  },
];

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-[#f8f7f4] flex flex-col">
      <section className="flex-1 flex flex-col justify-center px-6 py-20 max-w-lg mx-auto w-full">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-6">
          Personal accountability
        </p>
        <h1 className="text-4xl font-bold text-gray-950 leading-tight tracking-tight mb-3">
          Your commitments,
          <br />
          witnessed.
        </h1>
        <h2 className="text-2xl font-semibold text-gray-400 leading-tight tracking-tight mb-10">
          Your setbacks,
          <br />
          understood.
        </h2>

        <div className="space-y-5 mb-12">
          {PILLARS.map(({ label, body }) => (
            <div key={label} className="flex gap-4">
              <div className="mt-1 w-1.5 h-1.5 rounded-full bg-indigo-400 flex-shrink-0" />
              <div>
                <span className="text-sm font-semibold text-gray-900">{label}. </span>
                <span className="text-sm text-gray-500">{body}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          {USERS.map(({ id, label }) => (
            <Link
              key={id}
              href={`/${id}`}
              className="flex items-center justify-between bg-white rounded-2xl border border-gray-200 px-5 py-4 shadow-sm hover:border-gray-400 transition-colors group"
            >
              <span className="font-semibold text-gray-900">{label}</span>
              <span className="text-sm text-gray-400 group-hover:text-gray-600 transition-colors">/{id} →</span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}
