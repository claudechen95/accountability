import { HomePage } from "@/app/components/HabitTracker";

export default function Page({ params }: { params: { user: string } }) {
  return <HomePage userId={params.user} />;
}
