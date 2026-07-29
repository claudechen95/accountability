import { CoachPage } from "@/app/components/CoachView";

export default function Page({ params }: { params: { user: string } }) {
  return <CoachPage userId={params.user} />;
}
