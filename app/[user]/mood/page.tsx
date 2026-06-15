import { MoodPage } from "@/app/components/MoodView";

export default function Page({ params }: { params: { user: string } }) {
  return <MoodPage userId={params.user} />;
}
